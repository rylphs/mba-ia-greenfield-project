import { S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { requestViaInternalNetwork, uploadTestObject } from '../test/minio';
import { User } from '../users/entities/user.entity';
import { videoObjectKey } from '../storage/storage-keys';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { generateVideoSlug } from './video-slug';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const uploadCfg = {
  maxVideoSizeBytes: 10737418240,
  partSizeBytes: 67108864,
};

// Stub args for VideosService's video-processing dependencies, for describe
// blocks that don't exercise completeUpload and never touch the queue.
const NOOP_VIDEO_PROCESSING_CFG = { attempts: 3, backoffDelayMs: 1000 } as any;
const NOOP_QUEUE = { add: jest.fn() } as any;

const storageCfg = {
  endpoint: process.env.S3_ENDPOINT!,
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT!,
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  videosBucket: process.env.S3_VIDEOS_BUCKET || 'videos',
  thumbnailsBucket: process.env.S3_THUMBNAILS_BUCKET || 'thumbnails',
};

function buildS3Client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    forcePathStyle: true,
    region: storageCfg.region,
    credentials: {
      accessKeyId: storageCfg.accessKeyId,
      secretAccessKey: storageCfg.secretAccessKey,
    },
  });
}

describe('VideosService.createUpload (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let videosService: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    channelsService = new ChannelsService(dataSource);

    storageService = new StorageService(
      buildS3Client(storageCfg.endpoint),
      buildS3Client(storageCfg.publicEndpoint),
      storageCfg as any,
    );

    videosService = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      uploadCfg as any,
      NOOP_VIDEO_PROCESSING_CFG,
      NOOP_QUEUE,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const email = `videos_svc_${++userCounter}@example.com`;
    const user = await userRepository.save(
      userRepository.create({ email, password: 'hashed' }),
    );
    const channel = await channelsService.createChannel(user.id, email);
    return { userId: user.id, channelId: channel.id };
  }

  it('persists the video row with the upload_id from the real multipart upload', async () => {
    const { userId, channelId } = await createUserWithChannel();

    const result = await videosService.createUpload(userId, {
      fileName: 'ferias.mp4',
      fileSize: 1024,
      contentType: 'video/mp4',
    });

    expect(result.uploadId).toBeTruthy();

    const persisted = await videoRepository.findOneBy({ id: result.videoId });
    expect(persisted).not.toBeNull();
    expect(persisted!.upload_id).toBe(result.uploadId);
    expect(persisted!.channel_id).toBe(channelId);
  }, 30000);

  it('rolls back the DB insert when the storage call fails', async () => {
    const { userId } = await createUserWithChannel();
    jest
      .spyOn(storageService, 'createMultipartUpload')
      .mockRejectedValueOnce(new Error('storage down'));

    await expect(
      videosService.createUpload(userId, {
        fileName: 'a.mp4',
        fileSize: 1024,
        contentType: 'video/mp4',
      }),
    ).rejects.toThrow('storage down');

    const rows = await videoRepository.find();
    expect(rows).toHaveLength(0);
  });
});

describe('VideosService.presignParts (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let videosService: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    channelsService = new ChannelsService(dataSource);

    storageService = new StorageService(
      buildS3Client(storageCfg.endpoint),
      buildS3Client(storageCfg.publicEndpoint),
      storageCfg as any,
    );

    videosService = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      uploadCfg as any,
      NOOP_VIDEO_PROCESSING_CFG,
      NOOP_QUEUE,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<{ userId: string }> {
    const email = `videos_presign_${++userCounter}@example.com`;
    const user = await userRepository.save(
      userRepository.create({ email, password: 'hashed' }),
    );
    await channelsService.createChannel(user.id, email);
    return { userId: user.id };
  }

  it('returns a presigned URL that accepts a PUT and returns an ETag', async () => {
    const { userId } = await createUserWithChannel();
    const upload = await videosService.createUpload(userId, {
      fileName: 'ferias.mp4',
      fileSize: 1024,
      contentType: 'video/mp4',
    });

    const result = await videosService.presignParts(
      upload.videoId,
      userId,
      [1],
    );

    expect(result.parts).toHaveLength(1);
    const res = await requestViaInternalNetwork(result.parts[0].url, {
      method: 'PUT',
      body: Buffer.from('hello world'),
    });

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeTruthy();
    expect(new URL(result.parts[0].url).hostname).toBe(
      new URL(storageCfg.publicEndpoint).hostname,
    );
  }, 30000);
});

describe('VideosService.listUploadedParts (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let videosService: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    channelsService = new ChannelsService(dataSource);

    storageService = new StorageService(
      buildS3Client(storageCfg.endpoint),
      buildS3Client(storageCfg.publicEndpoint),
      storageCfg as any,
    );

    videosService = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      uploadCfg as any,
      NOOP_VIDEO_PROCESSING_CFG,
      NOOP_QUEUE,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<{ userId: string }> {
    const email = `videos_listparts_${++userCounter}@example.com`;
    const user = await userRepository.save(
      userRepository.create({ email, password: 'hashed' }),
    );
    await channelsService.createChannel(user.id, email);
    return { userId: user.id };
  }

  it('lists empty before any PUT, then only the uploaded parts after PUTs', async () => {
    const { userId } = await createUserWithChannel();
    const upload = await videosService.createUpload(userId, {
      fileName: 'ferias.mp4',
      fileSize: 200 * 1024 * 1024,
      contentType: 'video/mp4',
    });

    const before = await videosService.listUploadedParts(
      upload.videoId,
      userId,
    );
    expect(before.parts).toEqual([]);
    expect(before.partSize).toBe(upload.partSize);
    expect(before.partCount).toBe(upload.partCount);

    const presigned = await videosService.presignParts(
      upload.videoId,
      userId,
      [1, 3],
    );
    const putResults = await Promise.all(
      presigned.parts.map(({ url }) =>
        requestViaInternalNetwork(url, {
          method: 'PUT',
          body: Buffer.from('hello world'),
        }),
      ),
    );
    for (const res of putResults) {
      expect(res.status).toBe(200);
    }

    const after = await videosService.listUploadedParts(upload.videoId, userId);
    expect(after.parts).toHaveLength(2);
    expect(after.parts.map((p) => p.partNumber)).toEqual([1, 3]);
    for (const part of after.parts) {
      expect(part.etag).toBeTruthy();
      expect(part.size).toBe(Buffer.from('hello world').length);
    }
  }, 30000);
});

type CompleteUploadFixture = {
  dataSource: DataSource;
  videoRepository: Repository<Video>;
  storageService: StorageService;
  queue: Queue;
  videosService: VideosService;
  createUserWithChannel: () => Promise<{ userId: string }>;
  uploadSinglePart: (
    userId: string,
    fileSize: number,
    body: Buffer,
  ) => Promise<{ videoId: string; etag: string }>;
};

async function buildCompleteUploadFixture(
  uploadCfgOverride: { maxVideoSizeBytes: number; partSizeBytes: number },
  emailPrefix: string,
): Promise<CompleteUploadFixture> {
  const dataSource = createTestDataSource(ALL_ENTITIES);
  await dataSource.initialize();
  const userRepository = dataSource.getRepository(User);
  const videoRepository = dataSource.getRepository(Video);
  const channelsService = new ChannelsService(dataSource);

  const storageService = new StorageService(
    buildS3Client(storageCfg.endpoint),
    buildS3Client(storageCfg.publicEndpoint),
    storageCfg as any,
  );

  const queue = new Queue(VIDEO_PROCESSING_QUEUE, {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    },
  });

  const videosService = new VideosService(
    videoRepository,
    channelsService,
    storageService,
    uploadCfgOverride as any,
    { attempts: 3, backoffDelayMs: 1000 } as any,
    queue,
  );

  let userCounter = 0;
  async function createUserWithChannel(): Promise<{ userId: string }> {
    const email = `${emailPrefix}_${++userCounter}@example.com`;
    const user = await userRepository.save(
      userRepository.create({ email, password: 'hashed' }),
    );
    await channelsService.createChannel(user.id, email);
    return { userId: user.id };
  }

  async function uploadSinglePart(
    userId: string,
    fileSize: number,
    body: Buffer,
  ): Promise<{ videoId: string; etag: string }> {
    const upload = await videosService.createUpload(userId, {
      fileName: 'ferias.mp4',
      fileSize,
      contentType: 'video/mp4',
    });
    const presigned = await videosService.presignParts(
      upload.videoId,
      userId,
      [1],
    );
    const res = await requestViaInternalNetwork(presigned.parts[0].url, {
      method: 'PUT',
      body,
    });
    expect(res.status).toBe(200);
    return { videoId: upload.videoId, etag: res.headers.etag as string };
  }

  return {
    dataSource,
    videoRepository,
    storageService,
    queue,
    videosService,
    createUserWithChannel,
    uploadSinglePart,
  };
}

async function teardownCompleteUploadFixture(
  fx: CompleteUploadFixture,
): Promise<void> {
  await Promise.all([fx.queue.close(), fx.dataSource.destroy()]);
}

async function resetCompleteUploadFixture(
  fx: CompleteUploadFixture,
): Promise<void> {
  await Promise.all([
    cleanAllTables(fx.dataSource),
    fx.queue.obliterate({ force: true }),
  ]);
}

describe('VideosService.completeUpload (integration)', () => {
  let fx: CompleteUploadFixture;

  beforeAll(async () => {
    fx = await buildCompleteUploadFixture(uploadCfg, 'videos_complete');
  });

  afterAll(() => teardownCompleteUploadFixture(fx));
  beforeEach(() => resetCompleteUploadFixture(fx));

  it('completes the upload, commits processing status and enqueues the job', async () => {
    const { userId } = await fx.createUserWithChannel();
    const body = Buffer.from('hello world');
    const { videoId, etag } = await fx.uploadSinglePart(userId, 1024, body);

    const result = await fx.videosService.completeUpload(videoId, userId, [
      { partNumber: 1, etag },
    ]);

    expect(result).toEqual({
      videoId,
      slug: expect.any(String),
      processingStatus: VideoProcessingStatus.PROCESSING,
    });

    const persisted = await fx.videoRepository.findOneBy({ id: videoId });
    expect(persisted!.processing_status).toBe(VideoProcessingStatus.PROCESSING);

    const job = await fx.queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });

    const size = await fx.storageService.headObject(`${videoId}/original`);
    expect(size).toBe(body.length);
  }, 30000);

  it('rejects a second completion with INVALID_VIDEO_STATE and does not create a second job', async () => {
    const { userId } = await fx.createUserWithChannel();
    const body = Buffer.from('hello world');
    const { videoId, etag } = await fx.uploadSinglePart(userId, 1024, body);

    await fx.videosService.completeUpload(videoId, userId, [
      { partNumber: 1, etag },
    ]);

    await expect(
      fx.videosService.completeUpload(videoId, userId, [
        { partNumber: 1, etag },
      ]),
    ).rejects.toMatchObject({ errorCode: 'INVALID_VIDEO_STATE' });

    const jobCounts = await fx.queue.getJobCountByTypes(
      'active',
      'waiting',
      'delayed',
      'completed',
    );
    expect(jobCounts).toBe(1);
  }, 30000);
});

describe('VideosService.completeUpload — real size over the limit (integration)', () => {
  const smallUploadCfg = { maxVideoSizeBytes: 1024, partSizeBytes: 67108864 };
  let fx: CompleteUploadFixture;

  beforeAll(async () => {
    fx = await buildCompleteUploadFixture(
      smallUploadCfg,
      'videos_complete_toolarge',
    );
  });

  afterAll(() => teardownCompleteUploadFixture(fx));
  beforeEach(() => resetCompleteUploadFixture(fx));

  it('deletes the object, marks the video failed and enqueues no job when real size exceeds the limit', async () => {
    const { userId } = await fx.createUserWithChannel();
    // fileSize passes the declared-size check at creation; the real PUT body is larger.
    const { videoId, etag } = await fx.uploadSinglePart(
      userId,
      1000,
      Buffer.alloc(2048, 'x'),
    );

    await expect(
      fx.videosService.completeUpload(videoId, userId, [
        { partNumber: 1, etag },
      ]),
    ).rejects.toMatchObject({ errorCode: 'VIDEO_TOO_LARGE' });

    await expect(
      fx.storageService.headObject(`${videoId}/original`),
    ).rejects.toThrow();

    const persisted = await fx.videoRepository.findOneBy({ id: videoId });
    expect(persisted!.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(persisted!.processing_error).toBeTruthy();

    const job = await fx.queue.getJob(videoId);
    expect(job).toBeUndefined();
  }, 30000);
});

describe('VideosService presigned playback URLs (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let videosService: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    channelsService = new ChannelsService(dataSource);

    storageService = new StorageService(
      buildS3Client(storageCfg.endpoint),
      buildS3Client(storageCfg.publicEndpoint),
      storageCfg as any,
    );

    videosService = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      { ...uploadCfg, streamUrlExpiresSeconds: 21600 } as any,
      NOOP_VIDEO_PROCESSING_CFG,
      NOOP_QUEUE,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createReadyVideo(
    originalFilename = 'ferias.mp4',
  ): Promise<{
    userId: string;
    slug: string;
  }> {
    const email = `videos_playback_${++userCounter}@example.com`;
    const user = await userRepository.save(
      userRepository.create({ email, password: 'hashed' }),
    );
    const channel = await channelsService.createChannel(user.id, email);
    const body = Buffer.alloc(2048, 'x');
    const video = await videoRepository.save(
      videoRepository.create({
        slug: generateVideoSlug(),
        channel_id: channel.id,
        title: 'ferias',
        original_filename: originalFilename,
        content_type: 'video/mp4',
        declared_size_bytes: body.length,
        upload_part_size_bytes: body.length,
        upload_part_count: 1,
        processing_status: VideoProcessingStatus.READY,
      }),
    );
    await uploadTestObject(storageService, videoObjectKey(video.id), body);
    return { userId: user.id, slug: video.slug };
  }

  describe('getStreamUrl', () => {
    it('returns a presigned URL that serves a Range request with 206', async () => {
      const { userId, slug } = await createReadyVideo();

      const url = await videosService.getStreamUrl(slug, userId);

      const response = await requestViaInternalNetwork(url, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(response.status).toBe(206);
      expect(response.body.length).toBe(1024);
    }, 30000);
  });

  describe('getDownloadUrl', () => {
    it('returns a presigned URL that responds with the attachment disposition and full body', async () => {
      const { userId, slug } = await createReadyVideo('ferias.mp4');

      const url = await videosService.getDownloadUrl(slug, userId);

      const response = await requestViaInternalNetwork(url);
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="ferias.mp4"',
      );
      expect(response.body.length).toBe(2048);
    }, 30000);

    it('sanitizes a quoted original_filename in the disposition header', async () => {
      const { userId, slug } = await createReadyVideo('fe"rias.mp4');

      const url = await videosService.getDownloadUrl(slug, userId);

      const response = await requestViaInternalNetwork(url);
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="ferias.mp4"',
      );
    }, 30000);
  });
});
