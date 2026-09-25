import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { VideosService } from './videos.service';

function uniqueViolationError(column: string): QueryFailedError {
  const err = new QueryFailedError('', [], new Error('duplicate')) as any;
  err.code = '23505';
  err.detail = `Key (${column})=(x) already exists.`;
  return err;
}

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
