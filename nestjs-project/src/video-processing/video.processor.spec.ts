import { UnrecoverableError } from 'bullmq';
import { VideoProcessor } from './video.processor';

function fakeJob(overrides: {
  videoId: string;
  attemptsMade: number;
  attempts: number;
}): any {
  return {
    data: { videoId: overrides.videoId },
    attemptsMade: overrides.attemptsMade,
    opts: { attempts: overrides.attempts },
  };
}

describe('VideoProcessor', () => {
  let videoProcessingService: { process: jest.Mock; markFailed: jest.Mock };
  let processor: VideoProcessor;

  beforeEach(() => {
    videoProcessingService = {
      process: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    processor = new VideoProcessor(videoProcessingService as any);
  });

  describe('process', () => {
    it('delegates to VideoProcessingService.process with the job videoId', async () => {
      const job = fakeJob({ videoId: 'video-1', attemptsMade: 0, attempts: 3 });

      await processor.process(job);

      expect(videoProcessingService.process).toHaveBeenCalledWith('video-1');
    });
  });

  describe('onFailed', () => {
    it('marks the video failed when the error is an UnrecoverableError', async () => {
      const job = fakeJob({ videoId: 'video-1', attemptsMade: 1, attempts: 3 });
      const err = new UnrecoverableError('no video stream');

      await processor.onFailed(job, err);

      expect(videoProcessingService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'no video stream',
      );
    });

    it('marks the video failed when attempts are exhausted', async () => {
      const job = fakeJob({ videoId: 'video-1', attemptsMade: 3, attempts: 3 });
      const err = new Error('storage unavailable');

      await processor.onFailed(job, err);

      expect(videoProcessingService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'storage unavailable',
      );
    });

    it('does not mark the video failed when attempts remain', async () => {
      const job = fakeJob({ videoId: 'video-1', attemptsMade: 1, attempts: 3 });
      const err = new Error('storage unavailable');

      await processor.onFailed(job, err);

      expect(videoProcessingService.markFailed).not.toHaveBeenCalled();
    });

    it('does nothing when the job is undefined', async () => {
      await processor.onFailed(undefined, new Error('boom'));

      expect(videoProcessingService.markFailed).not.toHaveBeenCalled();
    });
  });
});
