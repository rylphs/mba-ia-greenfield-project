import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  S3_ENDPOINT: Joi.string().uri().required(),
  S3_PUBLIC_ENDPOINT: Joi.string().uri().required(),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: Joi.string().required(),
  S3_SECRET_ACCESS_KEY: Joi.string().required(),
  S3_VIDEOS_BUCKET: Joi.string().default('videos'),
  S3_THUMBNAILS_BUCKET: Joi.string().default('thumbnails'),
  MAX_VIDEO_SIZE_BYTES: Joi.number().default(10737418240),
  UPLOAD_PART_SIZE_BYTES: Joi.number()
    .min(5242880)
    .max(5368709120)
    .default(67108864),
  UPLOAD_URL_EXPIRES_SECONDS: Joi.number().positive().default(3600),
  STREAM_URL_EXPIRES_SECONDS: Joi.number().positive().default(21600),
  VIDEO_PROCESSING_ATTEMPTS: Joi.number().positive().default(3),
  VIDEO_PROCESSING_BACKOFF_MS: Joi.number().positive().default(1000),
  FFMPEG_TIMEOUT_MS: Joi.number().positive().default(30000),
});
