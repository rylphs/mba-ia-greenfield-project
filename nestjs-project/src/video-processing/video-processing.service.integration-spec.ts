import { execFile } from 'child_process';
import { promisify } from 'util';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import videoProcessingConfig from '../config/video-processing.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { videoObjectKey } from '../storage/storage-keys';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { uploadTestObject, requestViaInternalNetwork } from '../test/minio';
import { User } from '../users/entities/user.entity';
import { generateVideoSlug } from '../videos/video-slug';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg/ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const execFileAsync = promisify(execFile);
const FIXTURE_MAX_BUFFER = 50 * 1024 * 1024;

async function generateFixture(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('ffmpeg', args, {
    encoding: 'buffer',
    maxBuffer: FIXTURE_MAX_BUFFER,
  });
  return stdout;
}

describe('VideoProcessingService.process (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let ffmpegService: FfmpegService;
  let service: VideoProcessingService;
  let videoFixture: Buffer;
  let nonVideoFixture: Buffer;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    channelsService = new ChannelsService(dataSource);

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoProcessingConfig],
        }),
        StorageModule,
      ],
      providers: [FfmpegService],
    }).compile();

    storageService = module.get(StorageService);
    ffmpegService = module.get(FfmpegService);
    service = new VideoProcessingService(
      videoRepository,
      storageService,
      ffmpegService,
      module.get(videoProcessingConfig.KEY),
    );

    [videoFixture, nonVideoFixture] = await Promise.all([
      generateFixture([
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=1920x1080:rate=25:duration=2',
        '-c:v',
        'libx264',
        '-movflags',
        '+frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ]),
      Promise.resolve(Buffer.from('this is not a video file, just text')),
    ]);
  }, 60000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createVideoInProcessing(
    fixture: Buffer,
  ): Promise<{ videoId: string }> {
    const email = `video_proc_it_${++userCounter}@example.com`;
    const user = await userRepository.save(
      userRepository.create({ email, password: 'hashed' }),
    );
    const channel = await channelsService.createChannel(user.id, email);

    const video = await videoRepository.save(
      videoRepository.create({
        slug: generateVideoSlug(),
        channel_id: channel.id,
        title: 'ferias',
        original_filename: 'ferias.mp4',
        content_type: 'video/mp4',
        declared_size_bytes: fixture.length,
        upload_part_size_bytes: fixture.length,
        upload_part_count: 1,
        processing_status: VideoProcessingStatus.PROCESSING,
      }),
    );

    await uploadTestObject(storageService, videoObjectKey(video.id), fixture);

    return { videoId: video.id };
  }

  it('processes a valid video: metadata persisted, status ready, thumbnail publicly readable', async () => {
    const { videoId } = await createVideoInProcessing(videoFixture);

    await service.process(videoId);

    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted?.processing_status).toBe(VideoProcessingStatus.READY);
    expect(persisted?.width).toBe(1920);
    expect(persisted?.height).toBe(1080);
    expect(persisted?.video_codec).toBe('h264');
    expect(Number(persisted?.duration)).toBeCloseTo(2, 0);
    expect(persisted?.thumbnail_key).toBe(`${videoId}.jpg`);

    const publicUrl = storageService.getThumbnailPublicUrl(`${videoId}.jpg`);
    const response = await requestViaInternalNetwork(publicUrl);
    expect(response.status).toBe(200);
    expect(response.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 60000);

  it('throws UnrecoverableError for a non-video file and does not persist metadata', async () => {
    const { videoId } = await createVideoInProcessing(nonVideoFixture);

    await expect(service.process(videoId)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted?.processing_status).toBe(VideoProcessingStatus.PROCESSING);
    expect(persisted?.width).toBeNull();
  }, 30000);

  it('is idempotent: a second run on an already-ready video does not alter it', async () => {
    const { videoId } = await createVideoInProcessing(videoFixture);

    await service.process(videoId);
    const firstRun = await videoRepository.findOneBy({ id: videoId });

    await service.process(videoId);
    const secondRun = await videoRepository.findOneBy({ id: videoId });

    expect(secondRun).toEqual(firstRun);
  }, 60000);
});
