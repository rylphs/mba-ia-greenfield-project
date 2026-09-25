import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { requestViaInternalNetwork } from '../src/test/minio';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('GET /videos/{id}/upload/parts (e2e)', () => {
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
  ): Promise<{
    videoId: string;
    partSize: number;
    partCount: number;
  }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'ferias.mp4', fileSize, contentType: 'video/mp4' })
      .expect(201);
    return {
      videoId: res.body.videoId,
      partSize: res.body.partSize,
      partCount: res.body.partCount,
    };
  }

  it('lista-vazia-antes-de-qualquer-part', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'parts-list-1@example.com',
    );
    const { videoId, partSize, partCount } = await createVideo(access_token);

    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${access_token}`)
      .expect(200);

    expect(res.body.parts).toEqual([]);
    expect(res.body.partSize).toBe(partSize);
    expect(res.body.partCount).toBe(partCount);
  }, 30000);

  it('lista-apenas-as-parts-enviadas', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'parts-list-2@example.com',
    );
    const { videoId } = await createVideo(access_token, 200 * 1024 * 1024);

    const presignRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${access_token}`)
      .send({ partNumbers: [1, 3] })
      .expect(200);

    const uploads = await Promise.all(
      presignRes.body.parts.map(
        async ({ partNumber, url }: { partNumber: number; url: string }) => {
          const body = Buffer.from(`part-${partNumber}`);
          const putRes = await requestViaInternalNetwork(url, {
            method: 'PUT',
            body,
          });
          expect(putRes.status).toBe(200);
          return [
            partNumber,
            { etag: putRes.headers.etag, size: body.length },
          ] as const;
        },
      ),
    );
    const uploaded: Record<number, { etag: string; size: number }> =
      Object.fromEntries(uploads);

    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${access_token}`)
      .expect(200);

    expect(res.body.parts).toHaveLength(2);
    expect(
      res.body.parts.map((p: { partNumber: number }) => p.partNumber),
    ).toEqual([1, 3]);
    for (const part of res.body.parts) {
      expect(part.etag).toBe(uploaded[part.partNumber].etag);
      expect(part.size).toBe(uploaded[part.partNumber].size);
    }
  }, 30000);

  it('nao-dono-recebe-404', async () => {
    const owner = await registerConfirmAndLogin(
      'parts-list-3-owner@example.com',
    );
    const other = await registerConfirmAndLogin(
      'parts-list-3-other@example.com',
    );
    const { videoId } = await createVideo(owner.access_token);

    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${other.access_token}`)
      .expect(404);

    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });

  it('video-ready-recebe-409', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'parts-list-4@example.com',
    );
    const { videoId } = await createVideo(access_token);
    await videoRepository.update(videoId, {
      processing_status: VideoProcessingStatus.READY,
    });

    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}/upload/parts`)
      .set('Authorization', `Bearer ${access_token}`)
      .expect(409);

    expect(res.body.error).toBe('INVALID_VIDEO_STATE');
  });
});
