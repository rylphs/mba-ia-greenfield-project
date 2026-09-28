import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import uploadConfig from '../src/config/upload.config';
import { requestViaInternalNetwork } from '../src/test/minio';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../src/queue/queue.constants';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';

async function captureConfirmationToken(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  const authService = app.get(AuthService);
  const mailServiceInstance = (authService as any).mailService;
  let capturedToken = '';
  jest
    .spyOn(mailServiceInstance, 'sendConfirmationEmail')
    .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
      capturedToken = t;
    });
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password });
  return capturedToken;
}

async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<{ access_token: string }> {
  const token = await captureConfirmationToken(app, email, password);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token });
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password });
  return { access_token: res.body.access_token };
}

async function uploadSinglePart(
  app: INestApplication<App>,
  accessToken: string,
  fileSize: number,
  body: Buffer,
): Promise<{ videoId: string; etag: string }> {
  const createRes = await request(app.getHttpServer())
    .post('/videos')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ fileName: 'ferias.mp4', fileSize, contentType: 'video/mp4' })
    .expect(201);
  const videoId = createRes.body.videoId;

  const presignRes = await request(app.getHttpServer())
    .post(`/videos/${videoId}/upload/parts`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ partNumbers: [1] })
    .expect(200);

  const putRes = await requestViaInternalNetwork(presignRes.body.parts[0].url, {
    method: 'PUT',
    body,
  });
  expect(putRes.status).toBe(200);

  return { videoId, etag: putRes.headers.etag as string };
}

type CompleteUploadAppFixture = {
  app: INestApplication<App>;
  dataSource: DataSource;
  videoRepository: Repository<Video>;
  storageService: StorageService;
  queue: Queue;
};

async function bootstrapApp(
  uploadCfgOverride?: Record<string, number>,
): Promise<CompleteUploadAppFixture> {
  const moduleBuilder = Test.createTestingModule({ imports: [AppModule] });
  if (uploadCfgOverride) {
    moduleBuilder
      .overrideProvider(uploadConfig.KEY)
      .useValue(uploadCfgOverride);
  }
  const moduleFixture = await moduleBuilder.compile();

  const app: INestApplication<App> = moduleFixture.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  const dataSource = moduleFixture.get(DataSource);
  return {
    app,
    dataSource,
    videoRepository: dataSource.getRepository(Video),
    storageService: moduleFixture.get(StorageService),
    queue: moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE)),
  };
}

async function resetAppFixture(fx: CompleteUploadAppFixture): Promise<void> {
  await Promise.all([
    cleanAllTables(fx.dataSource),
    fx.queue.obliterate({ force: true }),
  ]);
}

describe('POST /videos/{id}/upload/complete (e2e)', () => {
  let fx: CompleteUploadAppFixture;
  let app: INestApplication<App>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let queue: Queue;

  beforeAll(async () => {
    fx = await bootstrapApp();
    ({ app, videoRepository, storageService, queue } = fx);
  });

  afterAll(() => app.close());
  beforeEach(() => resetAppFixture(fx));

  it('conclui-upload-e-enfileira-job', async () => {
    const { access_token } = await registerConfirmAndLogin(
      app,
      'complete-1@example.com',
    );
    const body = Buffer.from('hello world');
    const { videoId, etag } = await uploadSinglePart(
      app,
      access_token,
      1024,
      body,
    );

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(202);

    expect(res.body.videoId).toBe(videoId);
    expect(res.body.slug).toEqual(expect.any(String));
    expect(res.body.processingStatus).toBe(VideoProcessingStatus.PROCESSING);

    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted!.processing_status).toBe(VideoProcessingStatus.PROCESSING);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });

    const size = await storageService.headObject(`${videoId}/original`);
    expect(size).toBe(body.length);
  }, 30000);

  it('segunda-conclusao-recebe-409-sem-novo-job', async () => {
    const { access_token } = await registerConfirmAndLogin(
      app,
      'complete-2@example.com',
    );
    const body = Buffer.from('hello world');
    const { videoId, etag } = await uploadSinglePart(
      app,
      access_token,
      1024,
      body,
    );

    await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(202);

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(409);

    expect(res.body.error).toBe('INVALID_VIDEO_STATE');

    const jobCounts = await queue.getJobCountByTypes(
      'active',
      'waiting',
      'delayed',
      'completed',
    );
    expect(jobCounts).toBe(1);
  }, 30000);

  it('etag-divergente-recebe-400-e-mantem-awaiting-upload', async () => {
    const { access_token } = await registerConfirmAndLogin(
      app,
      'complete-3@example.com',
    );
    const { videoId } = await uploadSinglePart(
      app,
      access_token,
      1024,
      Buffer.from('hello world'),
    );

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({
        parts: [
          {
            partNumber: 1,
            etag: '"00000000000000000000000000000000"',
          },
        ],
      })
      .expect(400);

    expect(res.body.error).toBe('INVALID_UPLOAD_PARTS');

    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted!.processing_status).toBe(
      VideoProcessingStatus.AWAITING_UPLOAD,
    );

    const job = await queue.getJob(videoId);
    expect(job).toBeUndefined();
  }, 30000);

  it('nao-dono-recebe-404', async () => {
    const owner = await registerConfirmAndLogin(
      app,
      'complete-4-owner@example.com',
    );
    const other = await registerConfirmAndLogin(
      app,
      'complete-4-other@example.com',
    );
    const { videoId, etag } = await uploadSinglePart(
      app,
      owner.access_token,
      1024,
      Buffer.from('hello world'),
    );

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .set('Authorization', `Bearer ${other.access_token}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(404);

    expect(res.body.error).toBe('VIDEO_NOT_FOUND');

    const job = await queue.getJob(videoId);
    expect(job).toBeUndefined();
    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted!.processing_status).toBe(
      VideoProcessingStatus.AWAITING_UPLOAD,
    );
  }, 30000);
});

describe('POST /videos/{id}/upload/complete — real size over the limit (e2e)', () => {
  let fx: CompleteUploadAppFixture;
  let app: INestApplication<App>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let queue: Queue;

  beforeAll(async () => {
    fx = await bootstrapApp({
      maxVideoSizeBytes: 1024,
      partSizeBytes: 67108864,
      uploadUrlExpiresSeconds: 3600,
      streamUrlExpiresSeconds: 21600,
    });
    ({ app, videoRepository, storageService, queue } = fx);
  });

  afterAll(() => app.close());
  beforeEach(() => resetAppFixture(fx));

  it('tamanho-real-acima-do-limite-apaga-objeto-e-marca-failed', async () => {
    const { access_token } = await registerConfirmAndLogin(
      app,
      'complete-5@example.com',
    );
    const { videoId, etag } = await uploadSinglePart(
      app,
      access_token,
      1000,
      Buffer.alloc(2048, 'x'),
    );

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(400);

    expect(res.body.error).toBe('VIDEO_TOO_LARGE');

    await expect(
      storageService.headObject(`${videoId}/original`),
    ).rejects.toThrow();

    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted!.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(persisted!.processing_error).toBeTruthy();

    const job = await queue.getJob(videoId);
    expect(job).toBeUndefined();
  }, 30000);
});
