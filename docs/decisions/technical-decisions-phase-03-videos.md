---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-23
scope_description: "Backend foundation for video upload and processing: queue technology, worker topology, object storage runtime/layout/presigning, 10GB resumable upload protocol and limits, processing trigger, FFmpeg integration, unique video URL, streaming/download delivery and access, status model, and failure/retry policy."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the new `videos` module (entity + migration linked to `channels`), the storage and queue integrations, the video worker entrypoint, and the new Compose services (object storage, queue broker, worker). Every TD below applies to it.
- `next-frontend/` — no open decision in this document. The Phase 03 challenge (`docs/desafio-fase-03.md`) explicitly puts the video UI out of scope. The Cross-layer TDs (TD-06, TD-07, TD-11, TD-12) set the HTTP contract that a later frontend phase will consume through the BFF (`next-frontend-config-base/TD-03`). That TD already expected object-storage bytes to travel over presigned URLs rather than through the BFF.

_Research sources (context7, 2026-09-23):_ `/nestjs/docs.nestjs.com` (queues, standalone application context, lifecycle), `/nestjs/bull` (`@nestjs/bullmq` API), `/taskforcesh/bullmq` (retries, `UnrecoverableError`, deduplication, going-to-production, PostgreSQL backend), `/aws/aws-sdk-js-v3` (`getSignedUrl`, multipart commands, `forcePathStyle`, `ResponseContentDisposition`), `/minio/docs` + `/minio/minio` (`mc anonymous`, `mc ilm`, stale-upload expiry), `/tus/tus-node-server` (`S3Store`, lockers), `/websites/ffmpeg_documentation` (HTTP protocol seeking), `/fluent-ffmpeg/node-fluent-ffmpeg` (deprecation notice). Other primary sources: the npm registry (versions, `type`, peer ranges, release dates), the packed `@nestjs/bullmq@12.0.0` / `@11.0.5` tarballs, and the Docker Hub and quay.io tag APIs.

_Installed baseline (`nestjs-project/package-lock.json`):_ `@nestjs/core`/`common` 11.1.16, `typeorm` 0.3.28, `typescript` 5.9.3, `@nestjs/config` 4.0.3. The project compiles as CommonJS (`module: nodenext`, no `"type": "module"`), runs on `node:25.6.0-slim`, and tests with `ts-jest` 29.

_Changes from the 2026-09-22 draft (made without context7):_ same TDs and recommendations. Corrected facts: `@nestjs/bullmq@12` is ESM-only (TD-01). `@nestjs/bullmq` *can* reach the BullMQ PostgreSQL backend through `setDefaultBackendFactory` (TD-01 Option B). Redis must run with `maxmemory-policy noeviction` (TD-01). `forcePathStyle` is required for MinIO (TD-05). MinIO expires stale multipart uploads on its own through `MINIO_API_STALE_UPLOADS_EXPIRY`, while AWS S3 needs a lifecycle rule (TD-15). Permanent failures use BullMQ's `UnrecoverableError` (TD-15).

_Inherited constraints (not reopened):_ PostgreSQL 17 + TypeORM 0.3.28 (Phase 01); `@nestjs/config` + Joi env validation with namespaced `registerAs` configs (`phase-01-configuracao-base/TD-01..TD-04`); custom JWT guard with global auth and `@Public()` opt-out (`phase-02-auth/TD-02`); domain exception filter and error envelope (`phase-02-auth/TD-07`); class-validator DTOs (`phase-02-auth/TD-06`); `@nestjs/throttler` (`phase-02-auth/TD-08`); Compose service names as hosts (root `CLAUDE.md`).

---

## TD-01: Queue Technology (Message Queue)

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the Message Queue as "TBD". The API publishes one job per uploaded video and the worker consumes it. Jobs are few but heavy (minutes of FFmpeg per job), so the queue must provide retries with backoff, at-least-once delivery, and persistence across restarts. It must also integrate cleanly with NestJS 11.1 (installed). Throughput is not a concern.

**Options:**

### Option A: BullMQ + Redis via `@nestjs/bullmq`
- The official NestJS queue integration (`BullModule.forRootAsync` + `registerQueue`, `@InjectQueue`, `@Processor` + `WorkerHost`). Jobs live in Redis. Adds one Compose service (`redis`, or the BSD-licensed `valkey`, which is wire-compatible). **Version constraint:** `@nestjs/bullmq@12.0.0` accepts Nest 11 but is ESM-only (`"type": "module"`). `@nestjs/bullmq@11.0.5` is CommonJS with peers `@nestjs/* ^10 || ^11` and `bullmq ^3–^6`, so it matches this CJS/`ts-jest` project.
- **Pros:** Documented in the NestJS docs as the recommended queue. Most battle-tested BullMQ backend. Attempts, exponential backoff, `jobId`/`deduplication` handling, stalled-job recovery, `UnrecoverableError` and `failed`/`completed` events are built in. The worker side works through `createApplicationContext` with no HTTP server.
- **Cons:** One more stateful container to run and test against. BullMQ's production guide says it is correct only with Redis `maxmemory-policy noeviction`, and recommends AOF persistence. Both are Compose `command` flags. Jobs live outside PostgreSQL, so enqueueing cannot share a transaction with the `videos` row. That needs an ordering rule: commit first, then enqueue, with idempotent processing.

### Option B: BullMQ 6 with its PostgreSQL backend
- BullMQ 6.0.0 (released 2026-07-30) adds a pluggable backend. `createPostgresBackend` runs the same Queue/Worker/QueueEvents API on PostgreSQL ≥13 (≥14 recommended), with tables created by the idempotent `runMigrations()`. `setDefaultBackendFactory(createPostgresBackend)` makes it the process-wide default.
- **Pros:** No new container, because Postgres 17 is already in the stack. Same BullMQ API and feature set (retries, delayed jobs, flows). `@nestjs/bullmq` constructs `Queue`/`Worker` without a backend argument, so the process-wide default could route the Nest decorators to Postgres.
- **Cons:** Less than two months old (current 6.3.8). Throughput is lower than Redis, and the docs present the backend as an option for teams avoiding Redis. The `@nestjs/bullmq` connection options are typed for Redis, so the combination is undocumented and unverified. It needs a global side effect set before module init in both entrypoints. It also adds a second schema whose migrations run outside TypeORM, which affects the test-database truncation strategy.

### Option C: pg-boss
- A job queue on PostgreSQL (`SKIP LOCKED`). v12.33.6 is ESM-only (`"type": "module"`) and requires Node ≥22.12.
- **Pros:** No new container. Mature (years in production). Retries, backoff and dead-letter queues included.
- **Cons:** No official NestJS module: lifecycle, DI and graceful shutdown are hand-written. ESM-only in a CJS `nodenext` project works at runtime through `require(esm)` (Node 25), but it is a new interop surface for `ts-jest`. The challenge brief asks for a real queue service in Compose, and here the "queue" would be tables in `db`, which weakens the architecture diagram's separate Message Queue container.

### Option D: RabbitMQ via `@nestjs/microservices`
- An AMQP broker container. The worker is a Nest microservice consuming a durable queue.
- **Pros:** A real message broker with strong delivery semantics, and an official Nest transport.
- **Cons:** No built-in delayed retry or backoff: it needs dead-letter exchanges and TTL plumbing. The Nest RMQ transport is RPC/event-oriented, not job-oriented, so there is no job state, attempts or progress. The heaviest option for a single job type.

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)**. It is the only option with first-party NestJS support that works with the installed Nest 11. It gives retries, backoff and job-id deduplication without custom code, and it realizes the diagram's separate Message Queue container. The Redis container cost is small next to the storage and worker containers this phase adds anyway. Option B is attractive and technically reachable through `setDefaultBackendFactory`, but its combination with `@nestjs/bullmq` is undocumented and the backend is weeks old. That is too much risk for the phase's core infrastructure. Pin the CommonJS `@nestjs/bullmq@11.x` line (12.x is ESM-only) together with `bullmq@6`, and run Redis with `noeviction` + AOF. The job payload should carry only `{ videoId }`, with the DB as the source of truth. That keeps the queue replaceable later, including a move to Option B once it matures.

**Decision:** A
**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^6.3.8`

---

## TD-02: Video Worker Runtime Topology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The diagram defines a separate "Video Worker (FFmpeg)" container that reads and writes storage and updates the DB. FFmpeg jobs are CPU-bound and long. Running them in the API process would degrade request latency, which the plan forbids ("sem impacto na performance"). The worker needs the `Video` entity, TypeORM config, storage client and queue config that the API also uses.

**Options:**

### Option A: Same codebase, second entrypoint, separate Compose service
- `nestjs-project/src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)`, with no HTTP listener. `WorkerModule` imports the shared config, database, storage and videos-processing providers. A `video-worker` Compose service reuses the project's image, adds `ffmpeg`, and runs this entrypoint.
- **Pros:** No duplicated entities, config schema or storage client. One `package.json`, one test/lint/tsc pipeline, so the Definition of Done covers the worker automatically. Scales independently (`docker compose up --scale video-worker=N`). Matches the diagram.
- **Cons:** The worker image carries API dependencies it does not use. Module boundaries must keep HTTP-only providers (controllers, throttler, guards) out of `WorkerModule`. The NestJS docs note that a standalone context does not apply guards or interceptors anyway. Graceful shutdown (closing the BullMQ worker on `SIGTERM`) needs `enableShutdownHooks()`/`app.close()` in the worker's bootstrap.

### Option B: Processor inside the API process (`@Processor` registered in `AppModule`)
- The API container also consumes the queue, optionally in sandboxed child processes (`processors: [path]`).
- **Pros:** No extra service. The simplest wiring.
- **Cons:** FFmpeg competes for CPU and memory with HTTP handling, the exact thing the phase must avoid. Worker and API cannot scale separately. Contradicts the diagram's separate worker container.

### Option C: Separate subproject (`video-worker/`) with its own `package.json`
- An independent Node project (or a non-Node worker) with its own dependencies and image.
- **Pros:** Strongest isolation. Minimal image.
- **Cons:** Duplicates the entity, migrations ownership, config validation and storage client, or forces a shared `packages/` workspace that the repo does not have. Adds a third subproject to test, lint and document.

**Recommendation:** **Option A (same codebase, second entrypoint, separate Compose service)**. It gets the isolation that matters (a separate process and container that scales independently) without duplicating the data model or config. The Definition of Done stays a single `nestjs-project` pipeline. FFmpeg is installed in the image used by `video-worker` (see TD-09).

**Decision:** A

---

## TD-03: Object Storage Runtime Image (local S3-compatible service)

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage *product* is given: S3-compatible, MinIO locally and S3 in production (challenge brief). The *image source*, however, changed. MinIO stopped publishing community builds in Oct 2025 and archived its repo in 2026, and `minio/minio` no longer exists on Docker Hub (verified: the Hub API returns "object not found"). The last community releases are still pullable from `quay.io/minio/minio` and `quay.io/minio/mc` (latest tag verified: `RELEASE.2025-09-07T16-13-09Z.hotfix.7aa24e772`). The choice affects `compose.yaml`, the bucket-init mechanism and the env keys.

**Options:**

### Option A: MinIO from `quay.io`, pinned to the last community release
- `quay.io/minio/minio:<pinned tag>` for the server, plus a one-shot `quay.io/minio/mc` service that creates buckets and policies.
- **Pros:** Exactly the product named by the project and the challenge. Full S3 API coverage used here: multipart, presigned PUT/GET, `Range`, `response-content-disposition` override, lifecycle rules. Web console on `:9001` for debugging.
- **Cons:** Frozen and archived: no more security patches. Acceptable for local dev and tests only (production = S3). The registry could disappear like Docker Hub did.

### Option B: Chainguard MinIO image (`cgr.dev/chainguard/minio`)
- A maintained rebuild of MinIO from source, free tier.
- **Pros:** Same MinIO behavior with CVE-patched rebuilds.
- **Cons:** The free tier gives floating `latest` only: pinning versions needs a paid subscription, which breaks reproducible Compose files. Still an archived upstream codebase.

### Option C: A maintained alternative (Garage or SeaweedFS)
- Actively maintained S3-compatible servers (Garage AGPL, ~50 MB RAM; SeaweedFS Apache-2.0).
- **Pros:** Maintained and pinnable. Removes the dependency on an archived product.
- **Cons:** Deviates from the MinIO/S3 wording in the plan and challenge. S3 feature coverage varies (Garage has partial lifecycle support and no bucket policies, since it uses its own key/permission model). Garage's cluster layout needs extra init steps, and every difference is a way for local behavior to diverge from S3.

**Recommendation:** **Option A (MinIO from `quay.io`, pinned)**. It keeps the product the plan and challenge specify, pinned for reproducibility, and it covers every S3 feature the other TDs rely on. The archive risk is limited to dev/test, because the code talks only to the S3 API through `@aws-sdk/client-s3` and never imports a MinIO SDK. Moving to Option C later is a Compose-only change.

**Decision:** A

---

## TD-04: Storage Layout — Buckets, Object Keys and Thumbnail Exposure

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Originals (up to 10 GB, private) and thumbnails (small, shown in every listing from Phase 04 onward) have different access and caching needs. The layout is shared by the env schema (bucket names), the Compose init job (bucket creation and policies), the API (upload keys) and the worker (read original, write thumbnail).

**Options:**

### Option A: Single private bucket with prefixes
- One bucket, e.g. `streamtube`, with keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. Every read is presigned.
- **Pros:** One bucket to create and configure. Uniform access model.
- **Cons:** Every listing page must presign one URL per thumbnail. Presigned URLs change on every request, so browsers and CDNs cannot cache thumbnails.

### Option B: Two buckets — private `videos`, public-read `thumbnails`
- `videos` (private; keys `{videoId}/original`) is accessed only via presigned URLs (TD-12). `thumbnails` (anonymous read; keys `{videoId}.jpg`) is served by a stable public URL.
- **Pros:** Thumbnails get stable, cacheable URLs with no signing cost in listings. The original stays private. Storage-cost rules for large objects, such as expiring incomplete multipart uploads on S3 (TD-15), apply only to `videos`. The init job's `mc anonymous set download <alias>/thumbnails` grants anonymous read on thumbnails only.
- **Cons:** Two buckets and a bucket policy in the init job. A thumbnail URL is readable by anyone who knows the key. Keys use the UUID, not the public slug, so they are not enumerable. The Phase 04 custom thumbnail lands in the same public bucket.

**Recommendation:** **Option B (private `videos` + public-read `thumbnails`)**. Thumbnails are display assets meant to be visible, and listings in Phases 04–07 would otherwise presign dozens of URLs per page and lose all caching. Keys use the internal UUID (`videoId`), not the public slug (TD-11), so storage paths never depend on a URL-facing identifier.

**Decision:** B

---

## TD-05: Presigned URL Host Resolution Under Docker Networking

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** Inside Compose, the API and worker must reach storage at `http://minio:9000`, the service name (root `CLAUDE.md` Docker rule). Browsers cannot resolve `minio`. SigV4 presigned URLs sign the `Host`, so a URL signed for `minio:9000` cannot be rewritten to `localhost:9000` afterward. Every presigned URL handed to a client (upload parts, stream, download) needs a host that client can reach. The worker reads through presigned URLs too (TD-10), so it needs the internal host. This decision touches the env schema, `compose.yaml` and the storage service.

**Options:**

### Option A: Two S3 clients — internal endpoint for operations, public endpoint for client-facing presigning
- `S3_ENDPOINT=http://minio:9000` is used for all server-side calls and for URLs the worker consumes. `S3_PUBLIC_ENDPOINT=http://localhost:9000` is used only to presign URLs returned to external clients. Presigning is an offline computation, so the API never needs network access to the public host.
- **Pros:** Honors the service-name rule for all container-to-container traffic. No extra infra. In production, both keys point to the real S3 endpoint. Both clients use `forcePathStyle: true` for MinIO: the SDK otherwise builds virtual-hosted `bucket.minio` hostnames that neither side can resolve.
- **Cons:** Two configured clients, and code must pick the right one (internal for worker URLs, public for API responses). One more env key.

### Option B: One hostname reachable from both host and containers
- Presign with a name both sides resolve, e.g. `host.docker.internal:9000` via `extra_hosts: host-gateway`, or a `/etc/hosts` entry on the dev machine mapping `minio` to `127.0.0.1`.
- **Pros:** A single client and a single endpoint key.
- **Cons:** Container traffic leaves the Compose network through the host gateway, against the project's explicit Docker rule. Needs manual host setup (`/etc/hosts`) that breaks "clone and `docker compose up`".

### Option C: Reverse proxy fronting storage on a shared host
- An `nginx` service exposes storage on one public origin and forwards to `minio:9000`, preserving `Host`.
- **Pros:** One public origin, and a CORS/cache layer comes with it.
- **Cons:** One more container and config file. Host-header preservation with SigV4 is fragile. Solves a production concern (a CDN in front of S3) that this phase does not have.

**Recommendation:** **Option A (two clients: internal `S3_ENDPOINT` + client-facing `S3_PUBLIC_ENDPOINT`)**. It is the only option that keeps every container-to-container call on Compose service names, as the root `CLAUDE.md` requires, and it adds no infrastructure. Storage CORS for the public origin (browser multipart `PUT` must expose the `ETag` header) is configured in the storage init step.

**Decision:** A
**Libraries:** `@aws-sdk/client-s3@^3.1138.0`, `@aws-sdk/s3-request-presigner@^3.1138.0`

---

## TD-06: Upload Protocol for Files up to 10 GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The plan's attention points require that a 10 GB upload "não trave o sistema e permita retomar em caso de falha de conexão". The challenge fails any solution that pushes the file through the API in a way that blocks it. A single presigned `PUT` or `POST` is capped at 5 GB by S3, so it cannot meet the 10 GB requirement and is excluded. The protocol is the handshake that both backend and a future client implement.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (API orchestrates, bytes go straight to storage)
- `POST /videos` creates the draft row and calls `CreateMultipartUpload`, returning `videoId`, `uploadId`, part size and part count. The client requests presigned `UploadPart` URLs in batches (`getSignedUrl(client, new UploadPartCommand({ …, PartNumber, UploadId }), { expiresIn })` from `@aws-sdk/s3-request-presigner`; `PartNumber` 1–10000). It `PUT`s each part directly to storage and collects `ETag`s, then calls a completion endpoint (TD-08). Resume uses `ListParts` to find which parts already landed.
- **Pros:** Zero video bytes cross the API: the Node process handles only small JSON calls, so upload volume has no effect on API performance. Resumable per part, with parallel part uploads. Native S3 protocol, identical on MinIO and AWS. Supports objects far beyond 10 GB.
- **Cons:** The client must implement chunking, parallelism and resume against a custom handshake: no off-the-shelf standard client without an adapter (Uppy's `@uppy/aws-s3` supports this flow). Needs storage CORS exposing `ETag` (TD-05). Abandoned uploads leave orphan parts (TD-15).

### Option B: tus resumable protocol via `@tus/server` + `@tus/s3-store` inside the API
- The API mounts a tus endpoint. Clients use `tus-js-client`/Uppy. The API streams each chunk to S3 multipart through `@tus/s3-store`.
- **Pros:** An open, standardized resumable protocol with mature clients. Resume semantics come for free (`HEAD` offset).
- **Cons:** All 10 GB still flow through the API process: streamed, not buffered, but it consumes API bandwidth, sockets and event-loop time, which the challenge explicitly warns against. The default `MemoryLocker` is per-process, so horizontal scaling needs a shared (e.g. Redis) locker. `@tus/s3-store` also buffers each `partSize` chunk to local disk before upload. `@tus/server@2` is ESM-only, the same interop cost as `pg-boss`.

**Recommendation:** **Option A (S3 multipart with presigned part URLs)**. It is the only option that keeps the API entirely out of the data path, which is the core non-functional requirement of the phase. It resumes at part granularity and works unchanged on S3 in production. The cost of a custom handshake falls on a future frontend phase, where Uppy's S3 multipart plugin already covers it. The BFF only relays the small JSON calls.

**Decision:** A
**Libraries:** `@aws-sdk/client-s3@^3.1138.0`, `@aws-sdk/s3-request-presigner@^3.1138.0`

---

## TD-07: Upload Limits Contract — Part Size, Max Size, URL Expiry and Accepted Types

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Depends on TD-06. S3 multipart allows at most 10,000 parts of 5 MiB–5 GiB each. Someone has to decide the part size, and both sides must agree on it. The 10 GB ceiling must be enforced even though bytes never touch the API. These values show up in the env schema, the create-upload DTO/response and the client.

**Options:**

### Option A: Server-dictated fixed part size, server-computed part count
- The client declares `fileName`, `fileSize` and `contentType` when creating the upload. The API rejects `fileSize > MAX_VIDEO_SIZE_BYTES` (10 GiB) and non-`video/*` types, then returns `partSize` (env `UPLOAD_PART_SIZE_BYTES`, e.g. 64 MiB → at most 160 parts for 10 GiB) and `partCount`. It only presigns part numbers `1..partCount`. At completion, `HeadObject` checks the real `ContentLength ≤ MAX_VIDEO_SIZE_BYTES`. Presigned part URLs expire after `UPLOAD_URL_EXPIRES_SECONDS` (e.g. 1 h; the presigner's default is 900 s, so this must be passed explicitly as `expiresIn`), and the client asks for more when needed.
- **Pros:** One source of truth for the chunking math. The server bounds the number of signable parts, so a client cannot write unbounded data. Part size can be tuned via env without changing clients.
- **Cons:** One size for every network. 64 MiB parts retry slowly on bad connections.

### Option B: Client-proposed part size validated within bounds
- The client sends its desired `partSize` (validated between 5 MiB and a max). The server computes and bounds `partCount` from it.
- **Pros:** The client can adapt to its network (smaller parts on mobile).
- **Cons:** More validation surface and more combinations to test, for flexibility no client in this phase uses.

**Recommendation:** **Option A (server-dictated fixed part size)**. Keeping all chunking math on the server makes the 10 GB limit enforceable in two places: the declared size at creation and the real size via `HeadObject` at completion. The client contract stays minimal. Type validation at creation is a cheap first filter only; ffprobe in the worker (TD-09) is the authoritative check.

**Decision:** A

---

## TD-08: Upload Completion Detection and Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Depends on TD-01 and TD-06. Processing must start automatically once the object is fully in storage. Something has to finalize the multipart upload, move the status, and enqueue the job.

**Options:**

### Option A: Explicit completion endpoint in the API
- The client calls `POST /videos/{id}/upload/complete` with its `{ partNumber, etag }[]`. The API verifies ownership and status, calls `CompleteMultipartUpload`, checks the size (TD-07), sets the status to processing, commits, and then enqueues `{ videoId }` with `jobId = videoId`.
- **Pros:** Portable: pure S3 API, identical on MinIO and AWS. Synchronous feedback to the client (the upload is confirmed and processing has started). Ownership and state checks run in the service layer.
- **Cons:** If the client dies after the last part but before completion, the upload stays incomplete. Resuming (TD-06) or cleanup (TD-15) covers that case.

### Option B: Storage event notifications
- The bucket emits an object-created event, which triggers the API or queue. On MinIO this is a webhook or AMQP target; on AWS it is S3 → SQS/EventBridge.
- **Pros:** Fires only when the object really exists. No client call needed.
- **Cons:** A different mechanism per provider (MinIO config vs AWS infra), so local and production diverge. The client still has to call `CompleteMultipartUpload` somewhere. Adds an inbound webhook endpoint that needs its own authentication.

**Recommendation:** **Option A (explicit completion endpoint)**. Multipart uploads need an explicit `CompleteMultipartUpload` call anyway, so the API is already in the loop at the right moment. Making that call the trigger keeps local and production identical. The order "commit status → enqueue with `jobId = videoId`" plus an idempotent processor (TD-15) makes a crash between the two steps recoverable.

**Decision:** A

---

## TD-09: FFmpeg Integration in the Worker

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration and metadata (container, codecs, resolution, bitrate) and render one frame as the thumbnail. The usual Node wrapper, `fluent-ffmpeg`, was **archived on 2025-05-22**. Its README says it "no longer works properly with recent ffmpeg versions", and npm marks it unsupported. The binary source (OS package vs npm-bundled) also affects the worker image.

**Options:**

### Option A: System `ffmpeg`/`ffprobe` (installed via `apt` in the worker image) + a thin `execFile` wrapper
- The worker image installs Debian's `ffmpeg` package. A small injectable service runs `ffprobe -v error -print_format json -show_format -show_streams <input>` and parses the JSON. It runs `ffmpeg -ss <t> -i <input> -frames:v 1 -vf scale=… <out>.jpg` for the thumbnail. `execFile` takes an argument array, so there is no shell interpolation.
- **Pros:** No npm dependency. Machine-readable JSON output from ffprobe. Full control of arguments and timeouts. FFmpeg runs in a child process, so the worker's event loop stays free to renew BullMQ job locks. BullMQ docs list a CPU-blocked event loop as the cause of stalled, double-processed jobs. Security updates come with the base image. Easy to unit-test by mocking the wrapper, and to integration-test with a real binary in the container.
- **Cons:** We own the small wrapper, its argument building and its JSON typing.

### Option B: `fluent-ffmpeg`
- The long-standing fluent API wrapper around the binaries.
- **Pros:** A familiar API with many examples.
- **Cons:** Its README (via context7) says it is "deprecated… no longer maintained and no longer works properly with recent ffmpeg versions", and npm marks 2.1.3 "no longer supported". No fixes will come. Not acceptable for new code.

### Option C: npm-bundled binaries (`ffmpeg-static` / `ffprobe-static`) + `execFile`
- Static binaries are downloaded at `npm install`. The wrapper is the same as in A.
- **Pros:** No Dockerfile change. The same binary version everywhere.
- **Cons:** A large binary download in every `npm install`, including the API container that does not need it. Postinstall downloads from GitHub releases are fragile in CI. Binary updates are tied to the npm package's release cadence.

**Recommendation:** **Option A (system FFmpeg + `execFile` wrapper)**. `fluent-ffmpeg` is archived and broken, and the static-binary packages would burden the API's install for a worker-only need. The OS package plus a typed wrapper is small, patched with the base image, and fully testable with the real binary inside Compose. Thumbnail frame policy: a timestamp at ~10% of the duration, clamped to the video length, so very short videos still produce a frame.

**Decision:** A
**Libraries:** —

**Revisions:**

- 2026-09-23 — Saídas do processamento persistidas: `duration`, `width`, `height`, `video_codec`, `audio_codec` (nullable — vídeo sem trilha de áudio), `size_bytes` e `mime`/container, todos extraídos via ffprobe. Thumbnail em JPEG, capturada em ~10% da duração (clamp ao comprimento do vídeo), redimensionada para largura 1280 mantendo a proporção. _Rationale:_ clarificação das saídas do processamento (AMB-2 de validation.md).

---

## TD-10: How the Worker Reads the Source Video

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Depends on TD-05 and TD-09. The source can be 10 GB. ffprobe only needs the container header, which sits at the end of the file for non-"faststart" MP4s, and ffmpeg needs one frame. How the worker gets bytes into FFmpeg decides its disk use and job duration.

**Options:**

### Option A: FFmpeg reads directly from an internal presigned GET URL
- The worker presigns a short-lived GET with the internal client (`http://minio:9000`, TD-05) and passes the URL as `-i`. FFmpeg's `http` protocol detects seekability from the server response (`seekable=-1` by default) and seeks with `Range` requests. Reconnect options cover transient drops.
- **Pros:** Reads only the bytes it needs: header, index and one keyframe region. Typically a few MB even for 10 GB files. No temp disk, and the job takes seconds. Behaves the same against S3 in production.
- **Cons:** Many range requests if the index is fragmented. The worker needs network access to storage throughout the job, which it has anyway.

### Option B: Download the full object to a temp volume, then process the local file
- `GetObject` streams to a worker-local temp file, which is processed and then deleted.
- **Pros:** The most robust input for FFmpeg (local seeks). A simple mental model.
- **Cons:** Up to 10 GB of disk and network per job, just to read metadata and one frame. Job time scales with file size, and parallel jobs multiply disk needs.

### Option C: Stream `GetObject` into FFmpeg's stdin (`pipe:0`)
- Pipe the object body into the process.
- **Pros:** No temp disk.
- **Cons:** Pipes cannot seek. MP4s with the `moov` atom at the end fail or force reading the whole 10 GB, which makes it unreliable for exactly the common case.

**Recommendation:** **Option A (FFmpeg reads the internal presigned URL)**. It is the only option whose cost does not grow with file size: metadata and one frame need megabytes, not the full 10 GB. That keeps processing fast and the worker stateless. Option B's reliability advantage only matters for heavy transcoding, which Phase 03 does not do.

**Decision:** A

---

## TD-11: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** The plan asks for "uma URL curta e única que nunca conflite com outro vídeo" (Pontos de Atenção). The identifier becomes the public route segment (`/videos/{id}` in the API, and later the watch-page URL in the frontend), so it is a contract between both subprojects. The table's primary key follows the project convention (UUID, as in `channels`).

**Options:**

### Option A: Expose the UUID primary key
- Routes use `videos.id` directly.
- **Pros:** Zero extra columns or logic. Uniqueness is guaranteed.
- **Cons:** 36-character URLs, not "curta" as the plan requires. Ties the public contract to the storage key and primary key.

### Option B: Random short slug (11-char base64url, YouTube-style) with a unique index
- A separate `slug` column (`varchar(11)`, `UNIQUE`) generated from `crypto.randomBytes(8)` encoded base64url (≈64 bits). On the rare unique-violation, it regenerates and retries a bounded number of times.
- **Pros:** Short, non-sequential and non-enumerable. The DB unique constraint makes "never conflicts" a hard guarantee, not a probabilistic one. `node:crypto` only: no dependency (`nanoid@6` is ESM-only and unnecessary). The public identifier is decoupled from the PK and storage keys.
- **Cons:** One more column and a retry path, which needs a test.

### Option C: Encoded sequential integer (Sqids/Hashids over a serial column)
- A `bigserial` column encoded to a short string.
- **Pros:** Collision-free by construction. Very short.
- **Cons:** Reversible encoding leaks creation order and platform volume. Adds a serial column next to the UUID PK and a library dependency.

**Recommendation:** **Option B (random 11-char base64url slug + unique index)**. It is the only option that is short (as the plan requires) and non-enumerable. It needs no dependency, and the database constraint turns uniqueness into a guarantee. The slug is generated when the draft is pre-registered (TD-06), so the URL exists from the start of the upload.

**Decision:** B

---

## TD-12: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Depends on TD-04 and TD-05. Playback must start without downloading the whole file, which means HTTP `Range` / `206 Partial Content`. Download must return the whole file with `Content-Disposition: attachment`. The architecture diagram already shows "Frontend → Object Storage: Streams", and the BFF decision (`next-frontend-config-base/TD-03`) expects media bytes to travel over presigned storage URLs, not through the backend.

**Options:**

### Option A: API authorizes, storage serves — `302` redirect to a presigned GET URL
- `GET /videos/{slug}/stream` → `302 Location: <presigned GET>`. Storage answers `Range` with `206` natively. `GET /videos/{slug}/download` → `302` to a presigned `GetObjectCommand` with `ResponseContentDisposition: 'attachment; filename="…"'`, which the SDK encodes as the `response-content-disposition` query override. URLs are signed with the public endpoint (TD-05) and expire after `STREAM_URL_EXPIRES_SECONDS` (e.g. 6 h, long enough for a viewing session with seeks).
- **Pros:** No video bytes through the API, and seeking comes from S3/MinIO's `Range` support at no cost. Authorization stays in the API, because the redirect is issued only after the access checks (TD-13). The endpoint URL stays stable for `<video src>` while the signed target rotates. Works unchanged with a CDN in front of S3 later.
- **Cons:** When a URL expires mid-session, the player must re-request the stable endpoint to get a fresh one. The storage host becomes visible to clients.

### Option B: API proxies bytes with its own `Range` handling
- The API parses `Range`, calls `GetObject` with that range, and pipes the body with `206`, `Content-Range` and `Accept-Ranges`.
- **Pros:** Only one public origin. Per-request authorization on every byte range.
- **Cons:** All playback and download bandwidth flows through the API, the same performance problem the upload design avoids. Reimplements range semantics (multi-range, `416`, `If-Range`) that storage already handles correctly.

### Option C: HLS adaptive streaming (worker transcodes to segments + playlist)
- The worker produces `.m3u8` + `.ts`/`.m4s` renditions. Players fetch segments.
- **Pros:** Adaptive bitrate. The industry-standard delivery for large platforms.
- **Cons:** Heavy transcoding: CPU time comparable to video length, and storage multiplied by the number of renditions. Well beyond the phase's processing scope ("extração de duração e metadados", one thumbnail). Download still needs the original anyway.

**Recommendation:** **Option A (302 redirect to presigned GET, with `attachment` override for download)**. It satisfies "streaming sem download completo" through native `Range`/`206` from storage without pushing bytes through the API, and it matches the architecture diagram and the BFF decision. Download is the same mechanism with a different response header. HLS (C) can come later as a worker enhancement without changing these endpoints' contract.

**Decision:** A

---

## TD-13: Access Policy for Stream/Download Before Publication Exists

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Depends on TD-12 and TD-14. In Phase 03 every video is a draft: publishing and public/unlisted visibility arrive in Phase 04, and anonymous watching in Phase 05. The Authorization Matrix still has to say who may stream or download a ready video now. The global JWT guard requires an explicit `@Public()` for anonymous access.

**Options:**

### Option A: Owner-only while the video is a draft
- Stream and download require authentication, and the caller's channel must own the video, whose processing status must be `ready`. Phase 04 relaxes this for published and unlisted videos, and Phase 05 adds `@Public()` access.
- **Pros:** A draft stays private, consistent with the meaning of "rascunho". Phase 04/05 only widen the rule, never reverse it. It reuses the existing guard and channel ownership lookup.
- **Cons:** No anonymous playback demo in Phase 03, so the streaming capability is verified with an authenticated owner.

### Option B: Anyone with the slug may stream or download ready videos
- The endpoints are `@Public()`. The only requirement is that the processing status is `ready`.
- **Pros:** Exercises anonymous streaming early.
- **Cons:** Makes every draft effectively unlisted before Phase 04 defines visibility. Phase 04 would then have to *tighten* access, which is a breaking behavior change.

**Recommendation:** **Option A (owner-only while draft)**. It respects draft semantics and leaves Phases 04–05 purely additive (publish, then public/unlisted, then anonymous). Streaming and download are still fully exercised end to end by the owner.

**Decision:** A

---

## TD-14: Video Status Model

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video is pre-registered as a draft when the upload starts, then moves through processing. Phase 04 adds "Fluxo de rascunho → publicação" and visibility. The challenge expects the cycle "rascunho → processando → pronto/erro" to be reflected in the database. The status model drives the migration, the worker's state transitions and every access check.

**Options:**

### Option A: Single `status` enum for the whole lifecycle
- `status ∈ {draft, processing, ready, failed}` now, extended by Phase 04 with `published`.
- **Pros:** One column, and the simplest queries today.
- **Cons:** Conflates two independent axes: "is the file processed?" and "is it published?". A video that is ready but unpublished has to be `ready`, which stops meaning draft. Phase 04 would have to redefine or rename existing values, and transitions like "publish, then reprocess" become ambiguous.

### Option B: Two orthogonal columns — `processing_status` and `publication_status`
- `processing_status ∈ {awaiting_upload, processing, ready, failed}` is driven by the upload and worker. `publication_status ∈ {draft}` is set to `draft` at pre-registration, and Phase 04 adds `published` (visibility public/unlisted stays a separate Phase 04 concern). Invalid transitions are rejected in the service layer, e.g. no `complete` unless `awaiting_upload`, and the worker moves only `processing → ready | failed`.
- **Pros:** The rascunho→processando→pronto/erro cycle is fully represented: draft by `publication_status`, the processing stages by `processing_status`. Phase 04 extends `publication_status` without touching processing semantics. Access rules read naturally ("ready AND published").
- **Cons:** Two enums and two columns. Readers must check both where it matters.

**Recommendation:** **Option B (orthogonal `processing_status` + `publication_status`)**. Phase 04's "rascunho → publicação" flow is independent from processing, and modeling them separately now avoids a data migration and enum redefinition next phase. Failure details are stored in a nullable `processing_error` column for diagnosis (TD-15).

**Decision:** B
**Libraries:** —

**Revisions:**

- 2026-09-23 — Pré-cadastro do rascunho: o vídeo pertence ao canal do usuário autenticado (`channel_id`); `title` default = nome do arquivo original sem extensão; `description` nula; `publication_status = draft` e `processing_status` no estado inicial de upload. A Fase 03 não expõe endpoint de edição de metadados editoriais (título/descrição) — edição e fluxo rascunho→publicação ficam exclusivamente na Fase 04. _Rationale:_ clarificação de escopo e fronteira com a Fase 04 (AMB-1 de validation.md).

---

## TD-15: Failure, Retry and Abandoned-Upload Policy

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Depends on TD-01, TD-08 and TD-14. Processing can fail transiently (storage hiccup, worker restart) or permanently (the file is not a valid video). Uploads can also be abandoned midway, leaving orphan multipart parts (billed storage) and `awaiting_upload` rows. The plan's attention points ask to plan storage growth and cost from the start.

**Options:**

### Option A: Bounded automatic retries with backoff, idempotent processor, lifecycle cleanup of orphan parts
- Jobs are enqueued with `attempts` (e.g. 3) and `backoff: { type: 'exponential', delay }`, deduplicated by `jobId = videoId`. The processor is idempotent: it skips if already `ready`, and the thumbnail key is deterministic so a rewrite overwrites. Permanent errors (ffprobe finds no video stream) throw BullMQ's `UnrecoverableError`, which moves the job straight to failed and ignores the remaining attempts. After the final failure (the worker's `failed` event with `attemptsMade ≥ attempts`, or unrecoverable), the worker sets `processing_status = failed` and records `processing_error`. Orphan multipart parts are reclaimed by storage itself. Locally, MinIO has this built in: `MINIO_API_STALE_UPLOADS_EXPIRY` (default `24h`, swept every `6h`) is set explicitly in `compose.yaml`. On AWS S3 the equivalent is a bucket lifecycle rule `AbortIncompleteMultipartUpload`, a deploy-time concern. Stale `awaiting_upload` rows are left for Phase 04's management panel, which shows the status.
- **Pros:** Recovers transient failures automatically and fails fast on bad input with a first-class BullMQ primitive. Duplicate delivery (at-least-once, including stalled-job redelivery) is harmless. Orphan parts are reclaimed without cron code.
- **Cons:** Needs a typed error classification (transient vs permanent) in the processor. Retry and backoff values become config to tune. `jobId` deduplication only holds while the job is kept: BullMQ warns that `removeOnComplete`/`removeOnFail` let a same-id job be re-added. Retention must be chosen with that in mind, and the processor's idempotency is the real guard. The orphan-part cleanup mechanism differs between MinIO (server env) and S3 (lifecycle rule).

### Option B: No automatic retry — fail immediately, manual re-trigger
- A single attempt. Any error marks the video `failed`. A later endpoint could re-enqueue.
- **Pros:** The simplest processor. No retry configuration.
- **Cons:** A transient blip permanently fails a 10 GB upload that is perfectly valid. The re-trigger endpoint is not in the phase's capabilities, so users would have to re-upload.

**Recommendation:** **Option A (bounded retries + idempotent processor + multipart lifecycle rule)**. BullMQ already provides attempts, exponential backoff, `jobId` deduplication and `UnrecoverableError` (TD-01), so the only new code is error classification and the final `failed` transition. Storage-side expiry of stale multipart uploads (MinIO env locally, lifecycle rule on S3) answers the plan's storage-cost concern for abandoned 10 GB uploads without writing a scheduler.

**Decision:** A

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue technology | A — BullMQ 6 + Redis via `@nestjs/bullmq` 11.x (CJS) | A |
| TD-02 | Backend | Worker runtime topology | A — same codebase, second entrypoint, separate Compose service | A |
| TD-03 | Repo-wide | Object storage runtime image | A — MinIO from `quay.io`, pinned last community release | A |
| TD-04 | Backend | Storage layout (buckets/keys/thumbnails) | B — private `videos` + public-read `thumbnails` | B |
| TD-05 | Cross-layer | Presigned URL host resolution in Docker | A — internal `S3_ENDPOINT` + client-facing `S3_PUBLIC_ENDPOINT` | A |
| TD-06 | Cross-layer | Upload protocol for 10 GB | A — S3 multipart with presigned part URLs | A |
| TD-07 | Cross-layer | Upload limits contract | A — server-dictated fixed part size | A |
| TD-08 | Backend | Upload completion & processing trigger | A — explicit completion endpoint | A |
| TD-09 | Backend | FFmpeg integration | A — system FFmpeg + `execFile` wrapper | A |
| TD-10 | Backend | Worker source-file access | A — FFmpeg reads internal presigned URL | A |
| TD-11 | Cross-layer | Unique video URL identifier | B — random 11-char base64url slug + unique index | B |
| TD-12 | Cross-layer | Streaming & download delivery | A — 302 to presigned GET (+ `attachment` override) | A |
| TD-13 | Backend | Stream/download access before publication | A — owner-only while draft | A |
| TD-14 | Backend | Video status model | B — orthogonal `processing_status` + `publication_status` | B |
| TD-15 | Backend | Failure, retry & abandoned-upload policy | A — bounded retries + `UnrecoverableError` + idempotent processor + storage-side stale-upload expiry | A |
