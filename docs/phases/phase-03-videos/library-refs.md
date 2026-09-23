---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-23T18:21:02-03:00"
  "bullmq":
    version: "^6.3.8"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-23T18:21:02-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1138.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-23T18:21:02-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1138.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-23T18:21:02-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-23T18:19:32-03:00"
---

# Library References — phase-03-videos

### @nestjs/bullmq

_Used by: phase-03-videos/TD-01 (queue), TD-02 (worker entrypoint), TD-08 (enqueue on completion). Pin the CommonJS 11.x line — 12.x is ESM-only and the project compiles as CommonJS._

- **Root connection:** `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port } }) })`. Also overloaded as `forRootAsync(configKey, asyncConfig)` for named shared connections. Follow the inherited `registerAs` + `inject: [xxxConfig.KEY]` convention; host = Compose service name (`redis`), never `localhost`.
- **Queue registration:** `BullModule.registerQueue({ name: 'video-processing' })` in the module that produces or consumes jobs.
- **Producer (API):**

  ```typescript
  import { InjectQueue } from '@nestjs/bullmq';
  import { Queue } from 'bullmq';

  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
  await this.queue.add('process', { videoId }, { jobId: videoId, attempts, backoff });
  ```

- **Consumer (worker entrypoint only):** the class must extend `WorkerHost` and implement `process(job)`:

  ```typescript
  @Processor('video-processing')
  export class VideoProcessor extends WorkerHost {
    async process(job: Job<{ videoId: string }>) { /* ... */ }

    @OnWorkerEvent('failed')
    onFailed(job: Job, err: Error) { /* final failed transition */ }
  }
  ```

  `@Processor(queueNameOrOptions, workerOptions?)` accepts BullMQ worker options (e.g. `concurrency`) as its second argument. Register the processor **only** in the worker's module graph (TD-02 Option A), not in `AppModule`, so the API process never consumes jobs.

### bullmq

_Used by: phase-03-videos/TD-01, TD-08, TD-15._

- **Retries + exponential backoff** are set per job (or as queue `defaultJobOptions`):

  ```typescript
  await queue.add('process', { videoId }, {
    jobId: videoId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  });
  ```

  A job is retried while `attemptsMade + 1 < attempts` and the error is not an `UnrecoverableError`; otherwise it moves to the failed set.
- **Permanent failure (TD-15):** `throw new UnrecoverableError('...')` (imported from `bullmq`) moves the job straight to failed, ignoring the remaining attempts. Use it for non-retryable errors such as ffprobe rejecting the file as a non-video.
- **Deduplication:** a custom `jobId` makes `add` idempotent. The same id is not enqueued twice while the job exists, so re-calling the completion endpoint cannot double-enqueue. BullMQ also offers `deduplication: { id, ttl? }` (simple / throttle / debounce modes). `jobId = videoId` is the mechanism chosen in TD-08.
- **Redis requirement (TD-01):** run Redis with `maxmemory-policy noeviction` (and AOF for durability).

### @aws-sdk/client-s3

_Used by: phase-03-videos/TD-05 (two clients), TD-06 (multipart), TD-07 (HeadObject size check), TD-10 (internal presign for the worker), TD-15 (AbortMultipartUpload)._

- **Client for MinIO / S3-compatible storage:** `forcePathStyle: true` is required for MinIO.

  ```typescript
  new S3Client({
    endpoint: cfg.endpoint,          // internal: http://minio:9000 ; public: S3_PUBLIC_ENDPOINT
    forcePathStyle: true,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  });
  ```

  TD-05: instantiate **two** clients from the same config. The internal one (Compose service name) handles server-side operations. The public one is used **only** to presign client-facing URLs, because the signature binds the host.
- **Multipart commands:** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`. `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` takes `PartNumber` from 1 to 10000 and returns an `ETag` per part, which the browser must be allowed to read (CORS `ExposeHeaders: ETag`). `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` finishes the upload, and `AbortMultipartUploadCommand` cancels it.
- **Size verification (TD-07):** `HeadObjectCommand({ Bucket, Key })` → `ContentLength` (plus `ContentType`, `ETag`). Compare it with the 10 GB limit after completion.
- **Download header (TD-12):** `GetObjectCommand` input accepts `ResponseContentDisposition` (and `ResponseContentType`), which the presigned URL carries as query overrides. Set `attachment; filename="..."` for download and leave it unset (inline) for streaming.

### @aws-sdk/s3-request-presigner

_Used by: phase-03-videos/TD-05, TD-06, TD-10, TD-12._

- **Signature:** `getSignedUrl(client, command, { expiresIn })`. `expiresIn` is in seconds and **defaults to 900** (15 min) when omitted. TD-07 sets the explicit part-URL expiry.

  ```typescript
  import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

  // presigned part URL (browser PUT) — sign with the PUBLIC client
  await getSignedUrl(publicS3, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn });

  // stream / download redirect target (TD-12) — PUBLIC client
  await getSignedUrl(publicS3, new GetObjectCommand({ Bucket, Key, ResponseContentDisposition }), { expiresIn });

  // worker source read (TD-10) — INTERNAL client, host = Compose service name
  await getSignedUrl(internalS3, new GetObjectCommand({ Bucket, Key }), { expiresIn });
  ```

- The presigner is built from `client.config`, so the endpoint and `forcePathStyle` of the client passed in decide the URL host. That is why TD-05 picks the client per audience.
- `signableHeaders: new Set(['content-type'])` can force headers such as `Content-Type` to be part of the signature when a PUT must be constrained.
