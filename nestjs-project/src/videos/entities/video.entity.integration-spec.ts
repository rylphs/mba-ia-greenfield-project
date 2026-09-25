import { randomBytes, randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

function newSlug(): string {
  return randomBytes(8).toString('base64url');
}

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: 'video_user@example.com',
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: 'video_chan',
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Partial<Video> {
    return {
      slug: newSlug(),
      channel_id: channelId,
      title: 'my-video',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: 1024,
      upload_part_size_bytes: 1024,
      upload_part_count: 1,
      ...overrides,
    };
  }

  it('should enforce unique slug constraint', async () => {
    const channel = await createChannel();
    const slug = newSlug();

    await videoRepository.save(
      videoRepository.create(buildVideo(channel.id, { slug })),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(buildVideo(channel.id, { slug })),
      ),
    ).rejects.toThrow();
  });

  it('should reject a slug longer than 11 characters', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create(
          buildVideo(channel.id, { slug: 'a'.repeat(12) }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('should default processing_status/publication_status and leave optional fields null', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    expect(video.processing_status).toBe(VideoProcessingStatus.AWAITING_UPLOAD);
    expect(video.publication_status).toBe(VideoPublicationStatus.DRAFT);
    expect(video.description).toBeNull();
    expect(video.duration).toBeNull();
    expect(video.width).toBeNull();
    expect(video.height).toBeNull();
    expect(video.video_codec).toBeNull();
    expect(video.audio_codec).toBeNull();
    expect(video.size_bytes).toBeNull();
    expect(video.mime).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.processing_error).toBeNull();
  });

  it('should require a channel_id that references an existing channel', async () => {
    await expect(
      videoRepository.save(videoRepository.create(buildVideo(randomUUID()))),
    ).rejects.toThrow();
  });

  it('should persist and read back declared_size_bytes as a number', async () => {
    const channel = await createChannel();
    const declaredSizeBytes = 10737418240;

    const saved = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { declared_size_bytes: declaredSizeBytes }),
      ),
    );
    expect(saved.declared_size_bytes).toBe(declaredSizeBytes);

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.declared_size_bytes).toBe(declaredSizeBytes);
    expect(typeof found.declared_size_bytes).toBe('number');
  });
});
