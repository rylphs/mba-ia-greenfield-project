import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'streamtube',
  S3_SECRET_ACCESS_KEY: 'streamtube-secret',
};

const validate = (env: Record<string, string | undefined>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — S3_ENDPOINT', () => {
  it('should reject a non-URI S3_ENDPOINT', () => {
    const { error } = validate({ S3_ENDPOINT: 'not-a-uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should fail when S3_ENDPOINT is missing', () => {
    const { error } = validate({ S3_ENDPOINT: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });
});

describe('envValidationSchema — UPLOAD_PART_SIZE_BYTES', () => {
  it('should reject a part size below the S3 multipart minimum (5 MiB)', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '5242879' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should accept the S3 multipart minimum (5 MiB) exactly', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '5242880' });
    expect(error).toBeUndefined();
  });

  it('should apply the default part size (64 MiB) when not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(67108864);
  });
});

describe('envValidationSchema — VIDEO_PROCESSING_ATTEMPTS', () => {
  it('should reject VIDEO_PROCESSING_ATTEMPTS <= 0', () => {
    const { error } = validate({ VIDEO_PROCESSING_ATTEMPTS: '0' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_PROCESSING_ATTEMPTS');
  });
});

describe('envValidationSchema — MAX_VIDEO_SIZE_BYTES', () => {
  it('should default to 10 GiB when not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.MAX_VIDEO_SIZE_BYTES).toBe(10737418240);
  });
});

describe('envValidationSchema — .env.example', () => {
  it('should validate without error against the committed .env.example', () => {
    const envExamplePath = path.resolve(__dirname, '../../.env.example');
    const parsed = dotenv.parse(fs.readFileSync(envExamplePath));
    const { error } = envValidationSchema.validate(parsed, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeUndefined();
  });
});
