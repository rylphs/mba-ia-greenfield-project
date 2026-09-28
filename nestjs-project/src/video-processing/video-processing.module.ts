import { Module } from '@nestjs/common';
import { FfmpegService } from './ffmpeg/ffmpeg.service';

@Module({
  providers: [FfmpegService],
  exports: [FfmpegService],
})
export class VideoProcessingModule {}
