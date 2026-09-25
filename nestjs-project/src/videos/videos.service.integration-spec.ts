import { S3Client } from '@aws-sdk/client-s3';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { requestViaInternalNetwork } from '../test/minio';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const uploadCfg = {
  maxVideoSizeBytes: 10737418240,
  partSizeBytes: 67108864,
};

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
