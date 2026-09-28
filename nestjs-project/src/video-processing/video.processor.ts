import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../queue/queue.constants';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(
    private readonly videoProcessingService: VideoProcessingService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    await this.videoProcessingService.process(job.data.videoId);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    err: Error,
  ): Promise<void> {
    if (!job) {
      return;
    }
    const attempts = job.opts.attempts ?? 1;
    if (err instanceof UnrecoverableError || job.attemptsMade >= attempts) {
      await this.videoProcessingService.markFailed(job.data.videoId, err.message);
    }
  }
}
