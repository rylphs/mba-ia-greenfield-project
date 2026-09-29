import { UnrecoverableError } from 'bullmq';
import { VideoProcessingStatus } from '../videos/entities/video.entity';
import { NoVideoStreamError } from './ffmpeg/ffmpeg.errors';
import { VideoProcessingService } from './video-processing.service';

const CFG = { internalGetUrlExpiresSeconds: 900 };

const PROBE_RESULT = {
  duration: 12.5,
  width: 1920,
  height: 1080,
  video_codec: 'h264',
  audio_codec: 'aac',
  size_bytes: 1024,
  mime: 'mov,mp4,m4a,3gp,3g2,mj2',
};

function execFileExceptionLike(overrides: {
  code?: number | string;
  killed?: boolean;
}): Error {
  const err = new Error('exec failed') as Error & {
    code?: number | string;
    killed?: boolean;
  };
  Object.assign(err, overrides);
  return err;
}

describe('VideoProcessingService.process', () => {
  let videoRepo: { findOneBy: jest.Mock; update: jest.Mock };
  let storageService: {
    presignInternalGetObject: jest.Mock;
    putThumbnail: jest.Mock;
  };
  let ffmpegService: {
    probe: jest.Mock;
    computeThumbnailTimestamp: jest.Mock;
    extractThumbnail: jest.Mock;
  };
  let service: VideoProcessingService;

  beforeEach(() => {
    videoRepo = {
      findOneBy: jest.fn(),
      update: jest.fn(),
    };
    storageService = {
      presignInternalGetObject: jest
        .fn()
        .mockResolvedValue('https://internal/presigned'),
      putThumbnail: jest.fn().mockResolvedValue(undefined),
    };
    ffmpegService = {
      probe: jest.fn().mockResolvedValue(PROBE_RESULT),
      computeThumbnailTimestamp: jest.fn().mockReturnValue(1.25),
      extractThumbnail: jest.fn().mockResolvedValue(Buffer.from('jpeg')),
    };
    service = new VideoProcessingService(
      videoRepo as any,
      storageService as any,
      ffmpegService as any,
      CFG as any,
    );
  });

  it.each([VideoProcessingStatus.READY, VideoProcessingStatus.AWAITING_UPLOAD])(
    'skips without effect when the video status is %s',
    async (status) => {
      videoRepo.findOneBy.mockResolvedValue({
        id: 'video-1',
        processing_status: status,
      });

      await service.process('video-1');

      expect(storageService.presignInternalGetObject).not.toHaveBeenCalled();
      expect(videoRepo.update).not.toHaveBeenCalled();
    },
  );

  it('probes, extracts and persists metadata + thumbnail, then marks ready', async () => {
    videoRepo.findOneBy.mockResolvedValue({
      id: 'video-1',
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    await service.process('video-1');

    expect(storageService.presignInternalGetObject).toHaveBeenCalledWith(
      'video-1/original',
      expect.any(Number),
    );
    expect(ffmpegService.probe).toHaveBeenCalledWith(
      'https://internal/presigned',
    );
    expect(ffmpegService.computeThumbnailTimestamp).toHaveBeenCalledWith(
      PROBE_RESULT.duration,
    );
    expect(ffmpegService.extractThumbnail).toHaveBeenCalledWith(
      'https://internal/presigned',
      1.25,
    );
    expect(storageService.putThumbnail).toHaveBeenCalledWith(
      'video-1.jpg',
      Buffer.from('jpeg'),
    );
    expect(videoRepo.update).toHaveBeenCalledWith('video-1', {
      duration: PROBE_RESULT.duration,
      width: PROBE_RESULT.width,
      height: PROBE_RESULT.height,
      video_codec: PROBE_RESULT.video_codec,
      audio_codec: PROBE_RESULT.audio_codec,
      size_bytes: PROBE_RESULT.size_bytes,
      mime: PROBE_RESULT.mime,
      thumbnail_key: 'video-1.jpg',
      processing_status: VideoProcessingStatus.READY,
    });
  });

  it('converts a NoVideoStreamError from probe into an UnrecoverableError', async () => {
    videoRepo.findOneBy.mockResolvedValue({
      id: 'video-1',
      processing_status: VideoProcessingStatus.PROCESSING,
    });
    ffmpegService.probe.mockRejectedValue(
      new NoVideoStreamError('https://internal/presigned'),
    );

    await expect(service.process('video-1')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(videoRepo.update).not.toHaveBeenCalled();
  });

  it('converts a media-rejected exec failure (non-zero exit, not killed) into an UnrecoverableError', async () => {
    videoRepo.findOneBy.mockResolvedValue({
      id: 'video-1',
      processing_status: VideoProcessingStatus.PROCESSING,
    });
    ffmpegService.probe.mockRejectedValue(
      execFileExceptionLike({ code: 1, killed: false }),
    );

    await expect(service.process('video-1')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('propagates a transient exec failure (timeout, killed) for BullMQ to retry', async () => {
    videoRepo.findOneBy.mockResolvedValue({
      id: 'video-1',
      processing_status: VideoProcessingStatus.PROCESSING,
    });
    const transientErr = execFileExceptionLike({
      code: null as unknown as number,
      killed: true,
    });
    ffmpegService.probe.mockRejectedValue(transientErr);

    await expect(service.process('video-1')).rejects.toBe(transientErr);
  });

  it('propagates a plain transient error (e.g. storage/network) for BullMQ to retry', async () => {
    videoRepo.findOneBy.mockResolvedValue({
      id: 'video-1',
      processing_status: VideoProcessingStatus.PROCESSING,
    });
    const transientErr = new Error('storage unavailable');
    ffmpegService.probe.mockRejectedValue(transientErr);

    await expect(service.process('video-1')).rejects.toBe(transientErr);
  });

  it('throws when the video does not exist', async () => {
    videoRepo.findOneBy.mockResolvedValue(null);

    await expect(service.process('missing-id')).rejects.toThrow(
      'Video missing-id not found',
    );
  });
});

describe('VideoProcessingService.markFailed', () => {
  let videoRepo: { update: jest.Mock };
  let service: VideoProcessingService;

  beforeEach(() => {
    videoRepo = { update: jest.fn().mockResolvedValue(undefined) };
    service = new VideoProcessingService(
      videoRepo as any,
      {} as any,
      {} as any,
      CFG as any,
    );
  });

  it('builds the update with a processing-only guard clause', async () => {
    await service.markFailed('video-1', 'boom');

    expect(videoRepo.update).toHaveBeenCalledWith(
      { id: 'video-1', processing_status: VideoProcessingStatus.PROCESSING },
      {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: 'boom',
      },
    );
  });
});
