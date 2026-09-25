import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { requestViaInternalNetwork } from '../src/test/minio';
import uploadConfig from '../src/config/upload.config';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('POST /videos/{id}/upload/parts (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function captureConfirmationToken(
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
    email: string,
    password = 'password123',
  ): Promise<{ access_token: string }> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return { access_token: res.body.access_token };
  }

  async function createVideo(
    accessToken: string,
    fileSize = 104857600,
  ): Promise<{ videoId: string; partCount: number }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'ferias.mp4', fileSize, contentType: 'video/mp4' })
      .expect(201);
    return { videoId: res.body.videoId, partCount: res.body.partCount };
  }

  it('dono-recebe-urls-na-ordem-pedida-e-put-devolve-etag', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'presign-parts-1@example.com',
    );
    const { videoId } = await createVideo(access_token);

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ partNumbers: [2, 1] })
      .expect(200);

    expect(res.body.parts).toHaveLength(2);
    expect(res.body.parts[0].partNumber).toBe(2);
    expect(res.body.parts[1].partNumber).toBe(1);
    expect(new URL(res.body.parts[0].url).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
    );
    const cfg: ConfigType<typeof uploadConfig> = app.get(uploadConfig.KEY);
    expect(res.body.expiresIn).toBe(cfg.uploadUrlExpiresSeconds);

    const putRes = await requestViaInternalNetwork(res.body.parts[1].url, {
      method: 'PUT',
      body: Buffer.from('hello world'),
    });
    expect(putRes.status).toBe(200);
    expect(putRes.headers.etag).toBeTruthy();
  }, 30000);

  it('nao-dono-recebe-404', async () => {
    const owner = await registerConfirmAndLogin(
      'presign-parts-2-owner@example.com',
    );
    const other = await registerConfirmAndLogin(
      'presign-parts-2-other@example.com',
    );
    const { videoId } = await createVideo(owner.access_token);

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${other.access_token}`)
      .send({ partNumbers: [1] })
      .expect(404);

    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });

  it('part-number-acima-do-part-count', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'presign-parts-3@example.com',
    );
    const { videoId, partCount } = await createVideo(access_token);

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ partNumbers: [partCount + 1] })
      .expect(400);

    expect(res.body.error).toBe('INVALID_PART_NUMBER');
  });

  it('video-fora-de-awaiting-upload', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'presign-parts-4@example.com',
    );
    const { videoId } = await createVideo(access_token);
    await videoRepository.update(videoId, {
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ partNumbers: [1] })
      .expect(409);

    expect(res.body.error).toBe('INVALID_VIDEO_STATE');
  });

  it('id-nao-uuid-ou-part-numbers-vazio', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'presign-parts-5@example.com',
    );
    const { videoId } = await createVideo(access_token);

    const res1 = await request(app.getHttpServer())
      .post('/videos/not-a-uuid/upload/parts')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ partNumbers: [1] })
      .expect(400);
    expect(res1.body.error).toBe('VALIDATION_ERROR');

    const res2 = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ partNumbers: [] })
      .expect(400);
    expect(res2.body.error).toBe('VALIDATION_ERROR');
  });
});
