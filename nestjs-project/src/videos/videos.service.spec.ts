import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

function uniqueViolationError(column: string): QueryFailedError {
  const err = new QueryFailedError('', [], new Error('duplicate')) as any;
  err.code = '23505';
  err.detail = `Key (${column})=(x) already exists.`;
  return err;
}

// Stub args for VideosService's video-processing dependencies, for describe
// blocks that don't exercise completeUpload and never touch the queue.
const NOOP_VIDEO_PROCESSING_CFG = { attempts: 3, backoffDelayMs: 1000 } as any;
const NOOP_QUEUE = { add: jest.fn() } as any;

describe('VideosService.createUpload', () => {
  const uploadCfg = {
    maxVideoSizeBytes: 10737418240,
    partSizeBytes: 67108864,
  };
  const channel = { id: 'channel-1' };

  let channelsService: { findByUserId: jest.Mock };
  let storageService: { createMultipartUpload: jest.Mock };
  let manager: {
    query: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let videoRepo: { manager: { transaction: jest.Mock } };
  let service: VideosService;

  beforeEach(() => {
    channelsService = { findByUserId: jest.fn().mockResolvedValue(channel) };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id-1'),
    };
    manager = {
      query: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((_entity: unknown, data: unknown) => ({
        ...(data as object),
      })),
      save: jest.fn(async (entity: any) => ({ id: 'video-1', ...entity })),
      update: jest.fn().mockResolvedValue(undefined),
    };
    videoRepo = { manager: { transaction: jest.fn((cb: any) => cb(manager)) } };

    service = new VideosService(
      videoRepo as any,
      channelsService as unknown as ChannelsService,
      storageService as unknown as StorageService,
      uploadCfg as any,
      NOOP_VIDEO_PROCESSING_CFG,
      NOOP_QUEUE,
    );
  });

  it('throws VideoTooLargeException when fileSize exceeds the max', async () => {
    await expect(
      service.createUpload('user-1', {
        fileName: 'a.mp4',
        fileSize: uploadCfg.maxVideoSizeBytes + 1,
        contentType: 'video/mp4',
      }),
    ).rejects.toMatchObject({ errorCode: 'VIDEO_TOO_LARGE' });
  });

  it('throws UnsupportedVideoTypeException when contentType is not video/*', async () => {
    await expect(
      service.createUpload('user-1', {
        fileName: 'a.png',
        fileSize: 1024,
        contentType: 'image/png',
      }),
    ).rejects.toMatchObject({ errorCode: 'UNSUPPORTED_VIDEO_TYPE' });
  });

  it('derives title from fileName without extension', async () => {
    await service.createUpload('user-1', {
      fileName: 'ferias.mp4',
      fileSize: 1024,
      contentType: 'video/mp4',
    });

    expect(manager.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'ferias' }),
    );
  });

  it('computes partCount as ceil(fileSize / partSize)', async () => {
    const fileSize = uploadCfg.partSizeBytes * 2 + 1;

    const result = await service.createUpload('user-1', {
      fileName: 'a.mp4',
      fileSize,
      contentType: 'video/mp4',
    });

    expect(result.partCount).toBe(3);
    expect(result.partSize).toBe(uploadCfg.partSizeBytes);
  });

  it('retries slug generation on a unique violation and succeeds within the retry budget', async () => {
    manager.save
      .mockRejectedValueOnce(uniqueViolationError('slug'))
      .mockImplementationOnce(async (entity: any) => ({
        id: 'video-1',
        ...entity,
      }));

    const result = await service.createUpload('user-1', {
      fileName: 'a.mp4',
      fileSize: 1024,
      contentType: 'video/mp4',
    });

    expect(result.videoId).toBe('video-1');
    // 1 failed insert attempt + 1 successful insert
    expect(manager.save).toHaveBeenCalledTimes(2);
    expect(manager.update).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 failed slug attempts and rethrows the unique violation', async () => {
    manager.save.mockRejectedValue(uniqueViolationError('slug'));

    await expect(
      service.createUpload('user-1', {
        fileName: 'a.mp4',
        fileSize: 1024,
        contentType: 'video/mp4',
      }),
    ).rejects.toThrow();

    expect(manager.save).toHaveBeenCalledTimes(3);
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });
});

describe('VideosService.presignParts', () => {
  const uploadCfg = {
    maxVideoSizeBytes: 10737418240,
    partSizeBytes: 67108864,
    uploadUrlExpiresSeconds: 3600,
  };
  const baseVideo = {
    id: 'video-1',
    channel_id: 'channel-1',
    upload_id: 'upload-id-1',
    upload_part_count: 3,
    processing_status: VideoProcessingStatus.AWAITING_UPLOAD,
  };

  let storageService: { presignUploadPart: jest.Mock };
  let queryBuilder: {
    innerJoin: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
  let videoRepo: { manager: object; createQueryBuilder: jest.Mock };
  let service: VideosService;

  beforeEach(() => {
    storageService = {
      presignUploadPart: jest
        .fn()
        .mockImplementation((_key: string, _uploadId: string, n: number) =>
          Promise.resolve(`https://presigned.example/${n}`),
        ),
    };
    queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ ...baseVideo }),
    };
    videoRepo = {
      manager: {},
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    service = new VideosService(
      videoRepo as any,
      {} as unknown as ChannelsService,
      storageService as unknown as StorageService,
      uploadCfg as any,
      NOOP_VIDEO_PROCESSING_CFG,
      NOOP_QUEUE,
    );
  });

  it('throws VIDEO_NOT_FOUND when no owned video matches', async () => {
    queryBuilder.getOne.mockResolvedValue(null);

    await expect(
      service.presignParts('video-1', 'user-1', [1]),
    ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_FOUND' });

    expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
      'video.channel',
      'channel',
      'channel.user_id = :userId',
      { userId: 'user-1' },
    );
    expect(queryBuilder.where).toHaveBeenCalledWith('video.id = :videoId', {
      videoId: 'video-1',
    });
  });

  it('throws INVALID_VIDEO_STATE when the video is not awaiting upload', async () => {
    queryBuilder.getOne.mockResolvedValue({
      ...baseVideo,
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    await expect(
      service.presignParts('video-1', 'user-1', [1]),
    ).rejects.toMatchObject({ errorCode: 'INVALID_VIDEO_STATE' });
  });

  it('throws INVALID_PART_NUMBER when a part exceeds upload_part_count', async () => {
    await expect(
      service.presignParts('video-1', 'user-1', [1, 4]),
    ).rejects.toMatchObject({ errorCode: 'INVALID_PART_NUMBER' });
  });

  it('presigns each requested part and passes the configured expiresIn', async () => {
    const result = await service.presignParts('video-1', 'user-1', [2, 1]);

    expect(result.expiresIn).toBe(uploadCfg.uploadUrlExpiresSeconds);
    expect(result.parts).toEqual([
      { partNumber: 2, url: 'https://presigned.example/2' },
      { partNumber: 1, url: 'https://presigned.example/1' },
    ]);
    expect(storageService.presignUploadPart).toHaveBeenCalledWith(
      'video-1/original',
      'upload-id-1',
      2,
      uploadCfg.uploadUrlExpiresSeconds,
    );
  });
});

describe('VideosService.completeUpload', () => {
  const uploadCfg = { maxVideoSizeBytes: 1000, partSizeBytes: 67108864 };
  const videoProcessingCfg = { attempts: 3, backoffDelayMs: 1000 };
  const baseVideo = {
    id: 'video-1',
    slug: 'abc123xyz00',
    channel_id: 'channel-1',
    upload_id: 'upload-id-1',
    processing_status: VideoProcessingStatus.AWAITING_UPLOAD,
  };
  const parts = [{ partNumber: 1, etag: '"etag-1"' }];

  let storageService: {
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    deleteObject: jest.Mock;
  };
  let queryBuilder: {
    innerJoin: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
  let videoRepo: {
    manager: object;
    createQueryBuilder: jest.Mock;
    update: jest.Mock;
  };
  let queue: { add: jest.Mock };
  let service: VideosService;

  beforeEach(() => {
    storageService = {
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue(500),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ ...baseVideo }),
    };
    videoRepo = {
      manager: {},
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      update: jest.fn().mockResolvedValue(undefined),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new VideosService(
      videoRepo as any,
      {} as unknown as ChannelsService,
      storageService as unknown as StorageService,
      uploadCfg as any,
      videoProcessingCfg as any,
      queue as any,
    );
  });

  it('commits processing_status before enqueuing the job', async () => {
    const callOrder: string[] = [];
    videoRepo.update.mockImplementation(async () => {
      callOrder.push('update');
    });
    queue.add.mockImplementation(async () => {
      callOrder.push('add');
    });

    await service.completeUpload('video-1', 'user-1', parts);

    expect(callOrder).toEqual(['update', 'add']);
    expect(videoRepo.update).toHaveBeenCalledWith('video-1', {
      processing_status: VideoProcessingStatus.PROCESSING,
    });
  });

  it('enqueues the job with jobId, attempts and exponential backoff', async () => {
    await service.completeUpload('video-1', 'user-1', parts);

    expect(queue.add).toHaveBeenCalledWith(
      'process',
      { videoId: 'video-1' },
      {
        jobId: 'video-1',
        attempts: videoProcessingCfg.attempts,
        backoff: {
          type: 'exponential',
          delay: videoProcessingCfg.backoffDelayMs,
        },
      },
    );
  });

  it('throws VIDEO_TOO_LARGE, deletes the object and marks the video failed when real size exceeds the max', async () => {
    storageService.headObject.mockResolvedValue(
      uploadCfg.maxVideoSizeBytes + 1,
    );

    await expect(
      service.completeUpload('video-1', 'user-1', parts),
    ).rejects.toMatchObject({ errorCode: 'VIDEO_TOO_LARGE' });

    expect(storageService.deleteObject).toHaveBeenCalledWith(
      'video-1/original',
    );
    expect(videoRepo.update).toHaveBeenCalledWith(
      'video-1',
      expect.objectContaining({
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: expect.any(String),
      }),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('propagates INVALID_UPLOAD_PARTS from storage and does not enqueue', async () => {
    storageService.completeMultipartUpload.mockRejectedValue(
      Object.assign(new Error('Invalid part'), {
        errorCode: 'INVALID_UPLOAD_PARTS',
      }),
    );

    await expect(
      service.completeUpload('video-1', 'user-1', parts),
    ).rejects.toMatchObject({ errorCode: 'INVALID_UPLOAD_PARTS' });

    expect(videoRepo.update).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('throws INVALID_VIDEO_STATE when the video is not awaiting upload', async () => {
    queryBuilder.getOne.mockResolvedValue({
      ...baseVideo,
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    await expect(
      service.completeUpload('video-1', 'user-1', parts),
    ).rejects.toMatchObject({ errorCode: 'INVALID_VIDEO_STATE' });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
