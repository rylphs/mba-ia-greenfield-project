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
import { requestViaInternalNetwork } from '../src/test/minio';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
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

async function uploadAndCompleteReadyVideo(
  app: INestApplication<App>,
  accessToken: string,
  fileName = 'ferias.mp4',
  body = Buffer.alloc(2048, 'x'),
): Promise<{ videoId: string; slug: string }> {
  const createRes = await request(app.getHttpServer())
    .post('/videos')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ fileName, fileSize: body.length, contentType: 'video/mp4' })
    .expect(201);
  const { videoId, slug } = createRes.body;

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
  const etag = putRes.headers.etag as string;

  await request(app.getHttpServer())
    .post(`/videos/${videoId}/upload/complete`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ parts: [{ partNumber: 1, etag }] })
    .expect(202);

  return { videoId, slug };
}

type DownloadAppFixture = {
  app: INestApplication<App>;
  dataSource: DataSource;
  videoRepository: Repository<Video>;
  queue: Queue;
};

async function bootstrapApp(): Promise<DownloadAppFixture> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

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
    queue: moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE)),
  };
}

async function resetAppFixture(fx: DownloadAppFixture): Promise<void> {
  await Promise.all([
    cleanAllTables(fx.dataSource),
    fx.queue.obliterate({ force: true }),
  ]);
}

async function markReady(
  videoRepository: Repository<Video>,
  videoId: string,
): Promise<void> {
  await videoRepository.update(videoId, {
    processing_status: VideoProcessingStatus.READY,
  });
}

describe('GET /videos/{slug}/download (e2e)', () => {
  let fx: DownloadAppFixture;
  let app: INestApplication<App>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    fx = await bootstrapApp();
    ({ app, videoRepository } = fx);
  });

  afterAll(() => app.close());
  beforeEach(() => resetAppFixture(fx));

  it('download-devolve-arquivo-completo-como-anexo', async () => {
    const { access_token } = await registerConfirmAndLogin(
      app,
      'download-owner-1@example.com',
    );
    const body = Buffer.alloc(2048, 'x');
    const { videoId, slug } = await uploadAndCompleteReadyVideo(
      app,
      access_token,
      'ferias.mp4',
      body,
    );
    await markReady(videoRepository, videoId);

    const res = await request(app.getHttpServer())
      .get(`/videos/${slug}/download`)
      .set('Authorization', `Bearer ${access_token}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toEqual(
      expect.stringContaining(process.env.S3_PUBLIC_ENDPOINT!),
    );

    const downloadRes = await requestViaInternalNetwork(res.headers.location);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers['content-disposition']).toBe(
      'attachment; filename="ferias.mp4"',
    );
    expect(downloadRes.body.equals(body)).toBe(true);
  }, 30000);

  it('nome-com-aspas-gera-disposition-bem-formada', async () => {
    const { access_token } = await registerConfirmAndLogin(
      app,
      'download-owner-2@example.com',
    );
    const { videoId, slug } = await uploadAndCompleteReadyVideo(
      app,
      access_token,
      'fe"rias.mp4',
    );
    await markReady(videoRepository, videoId);

    const res = await request(app.getHttpServer())
      .get(`/videos/${slug}/download`)
      .set('Authorization', `Bearer ${access_token}`)
      .redirects(0)
      .expect(302);

    const downloadRes = await requestViaInternalNetwork(res.headers.location);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers['content-disposition']).toBe(
      'attachment; filename="ferias.mp4"',
    );
  }, 30000);

  it('video-em-processing-recebe-409', async () => {
    const { access_token } = await registerConfirmAndLogin(
      app,
      'download-owner-3@example.com',
    );
    const { videoId, slug } = await uploadAndCompleteReadyVideo(
      app,
      access_token,
    );
    await videoRepository.update(videoId, {
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    const res = await request(app.getHttpServer())
      .get(`/videos/${slug}/download`)
      .set('Authorization', `Bearer ${access_token}`)
      .expect(409);

    expect(res.body.error).toBe('VIDEO_NOT_READY');
  }, 30000);

  it('nao-dono-recebe-404', async () => {
    const { access_token: ownerToken } = await registerConfirmAndLogin(
      app,
      'download-owner-4@example.com',
    );
    const { videoId, slug } = await uploadAndCompleteReadyVideo(
      app,
      ownerToken,
    );
    await markReady(videoRepository, videoId);
    const { access_token: otherToken } = await registerConfirmAndLogin(
      app,
      'download-other-4@example.com',
    );

    const res = await request(app.getHttpServer())
      .get(`/videos/${slug}/download`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);

    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  }, 30000);
});
