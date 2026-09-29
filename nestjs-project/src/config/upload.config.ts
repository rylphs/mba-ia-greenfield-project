import { registerAs } from '@nestjs/config';

export default registerAs('upload', () => ({
  maxVideoSizeBytes: parseInt(
    process.env.MAX_VIDEO_SIZE_BYTES || '10737418240',
    10,
  ),
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES || '67108864', 10),
  uploadUrlExpiresSeconds: parseInt(
    process.env.UPLOAD_URL_EXPIRES_SECONDS || '3600',
    10,
  ),
  streamUrlExpiresSeconds: parseInt(
    process.env.STREAM_URL_EXPIRES_SECONDS || '21600',
    10,
  ),
}));
