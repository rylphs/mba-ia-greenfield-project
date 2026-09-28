import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnrecoverableError } from 'bullmq';
import videoProcessingConfig from '../config/video-processing.config';
import { isExecNonZeroExit } from '../common/child-process/exec-errors';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { videoObjectKey, thumbnailObjectKey } from '../storage/storage-keys';
import { FfmpegService } from './ffmpeg/ffmpeg.service';
import { NoVideoStreamError } from './ffmpeg/ffmpeg.errors';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepo: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(videoProcessingConfig.KEY)
    private readonly videoProcessingCfg: ConfigType<
      typeof videoProcessingConfig
    >,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepo.findOneBy({ id: videoId });
    if (!video) {
      throw new Error(`Video ${videoId} not found`);
    }
    // Idempotent: READY (already processed) and any other non-PROCESSING
    // status (e.g. failed) are both no-ops here.
    if (video.processing_status !== VideoProcessingStatus.PROCESSING) {
      return;
    }

    const inputUrl = await this.storageService.presignInternalGetObject(
      videoObjectKey(video.id),
      this.videoProcessingCfg.internalGetUrlExpiresSeconds,
    );

    const probeResult = await this.runFfmpegStep(() =>
      this.ffmpegService.probe(inputUrl),
    );

    const timestamp = this.ffmpegService.computeThumbnailTimestamp(
      probeResult.duration,
    );
    const thumbnail = await this.runFfmpegStep(() =>
      this.ffmpegService.extractThumbnail(inputUrl, timestamp),
    );

    const thumbnailKey = thumbnailObjectKey(video.id);
    await this.storageService.putThumbnail(thumbnailKey, thumbnail);

    await this.videoRepo.update(video.id, {
      duration: probeResult.duration,
      width: probeResult.width,
      height: probeResult.height,
      video_codec: probeResult.video_codec,
      audio_codec: probeResult.audio_codec,
      size_bytes: probeResult.size_bytes,
      mime: probeResult.mime,
      thumbnail_key: thumbnailKey,
      processing_status: VideoProcessingStatus.READY,
    });
  }

  async markFailed(videoId: string, message: string): Promise<void> {
    await this.videoRepo.update(
      { id: videoId, processing_status: VideoProcessingStatus.PROCESSING },
      {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: message,
      },
    );
  }

  // ffprobe/ffmpeg exit with a numeric, non-killed exit code when they run
  // and reject the input as invalid media (e.g. "Invalid data found when
  // processing input") — a timeout (killed: true) or a spawn-level failure
  // (string errno code) are transient and must retry instead.
  private async runFfmpegStep<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (err) {
      if (err instanceof NoVideoStreamError || isExecNonZeroExit(err)) {
        throw new UnrecoverableError((err as Error).message);
      }
      throw err;
    }
  }
}
