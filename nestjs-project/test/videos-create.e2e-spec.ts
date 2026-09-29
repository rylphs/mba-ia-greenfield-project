import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail/mail.service';
import { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { CreateVideoUploadResponseDto } from '../src/videos/dto/create-video-upload-response.dto';
import { Video } from '../src/videos/entities/video.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('POST /videos (e2e)', () => {
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
    const mailService = app.get(MailService);
    let capturedToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
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
    return {
      access_token: (res.body as { access_token: string }).access_token,
    };
  }

  it('cria-rascunho-e-retorna-contrato-de-upload', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'videos-create-1@example.com',
    );

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${access_token}`)
      .send({
        fileName: 'ferias.mp4',
        fileSize: 104857600,
        contentType: 'video/mp4',
      })
      .expect(201);

    const body = res.body as CreateVideoUploadResponseDto;
    expect(body.videoId).toBeDefined();
    expect(body.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(typeof body.uploadId).toBe('string');
    expect(body.uploadId.length).toBeGreaterThan(0);
    expect(body.partSize).toBeGreaterThan(0);
    expect(body.partCount).toBe(Math.ceil(104857600 / body.partSize));

    const row = await videoRepository.findOneBy({ id: body.videoId });
    expect(row).not.toBeNull();
    expect(row!.title).toBe('ferias');
    expect(row!.description).toBeNull();
    expect(row!.publication_status).toBe('draft');
    expect(row!.processing_status).toBe('awaiting_upload');
    expect(row!.upload_id).toBe(body.uploadId);
  });

  it('rejeita-tamanho-declarado-acima-do-limite', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'videos-create-2@example.com',
    );

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${access_token}`)
      .send({
        fileName: 'grande.mp4',
        fileSize: 10737418241,
        contentType: 'video/mp4',
      })
      .expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_TOO_LARGE');
    expect(await videoRepository.find()).toHaveLength(0);
  });

  it('rejeita-content-type-que-nao-e-video', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'videos-create-3@example.com',
    );

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${access_token}`)
      .send({
        fileName: 'foto.png',
        fileSize: 1024,
        contentType: 'image/png',
      })
      .expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('UNSUPPORTED_VIDEO_TYPE');
    expect(await videoRepository.find()).toHaveLength(0);
  });

  it('rejeita-body-sem-file-name', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'videos-create-4@example.com',
    );

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ fileSize: 1024, contentType: 'video/mp4' })
      .expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
  });

  it('exige-access-token', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send({
        fileName: 'ferias.mp4',
        fileSize: 1024,
        contentType: 'video/mp4',
      })
      .expect(401);

    expect(await videoRepository.find()).toHaveLength(0);
  });

  it('gera-slugs-distintos-entre-uploads', async () => {
    const { access_token } = await registerConfirmAndLogin(
      'videos-create-6@example.com',
    );

    const body = {
      fileName: 'ferias.mp4',
      fileSize: 1024,
      contentType: 'video/mp4',
    };

    const res1 = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${access_token}`)
      .send(body)
      .expect(201);
    const res2 = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${access_token}`)
      .send(body)
      .expect(201);

    expect((res1.body as CreateVideoUploadResponseDto).slug).not.toBe(
      (res2.body as CreateVideoUploadResponseDto).slug,
    );
  });
});
