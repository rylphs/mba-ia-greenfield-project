import { registerAs } from '@nestjs/config';

export default registerAs('videoProcessing', () => ({
  attempts: parseInt(process.env.VIDEO_PROCESSING_ATTEMPTS || '3', 10),
  backoffDelayMs: parseInt(
    process.env.VIDEO_PROCESSING_BACKOFF_MS || '1000',
    10,
  ),
  ffmpegTimeoutMs: parseInt(process.env.FFMPEG_TIMEOUT_MS || '30000', 10),
}));
