---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-23T18:21:36-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-23T18:21:25-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-23T18:19:32-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-18T08:30:32-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend foundation for videos — object storage for videos and thumbnails, a background processing queue with a dedicated video worker, direct-to-storage multipart upload of files up to 10GB with automatic draft pre-registration, automatic processing (duration/metadata extraction and thumbnail generation from a frame), a unique short URL per video, and owner-authorized streaming and download — so that 10GB uploads work without impacting API performance, processing runs automatically, streaming works and unique URLs are generated.

---

## Step Implementations

### SI-03.1 — Infra: dependências, Redis e MinIO no Compose

**Description:** Instala as bibliotecas de fila e S3 e sobe a infraestrutura de fila (Redis) e armazenamento (MinIO com buckets `videos`/`thumbnails`) no Compose — base para todo o resto da fase.

**Technical actions:**

1. Instalar no container `nestjs-api`: `@nestjs/bullmq@^11.0.5` (linha CommonJS 11.x — 12.x é ESM-only), `bullmq@^6.3.8`, `@aws-sdk/client-s3@^3.1138.0`, `@aws-sdk/s3-request-presigner@^3.1138.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
2. Adicionar serviço `redis` em `nestjs-project/compose.yaml` com `command` contendo `--maxmemory-policy noeviction --appendonly yes`, volume nomeado para AOF e healthcheck `redis-cli ping` (per `phase-03-videos/TD-01`)
3. Adicionar serviço `minio` (`quay.io/minio/minio:<tag pinada da última release community>`, `server /data --console-address :9001`, portas `9000`/`9001`, volume nomeado, `MINIO_API_STALE_UPLOADS_EXPIRY=24h` explícito, healthcheck em `/minio/health/live`) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-15`)
4. Adicionar serviço one-shot `minio-init` (`quay.io/minio/mc`, `depends_on: minio: service_healthy`) que cria os buckets `videos` e `thumbnails`, aplica `mc anonymous set download <alias>/thumbnails` e configura CORS para a origem pública com `ETag` exposto no bucket `videos` — mecanismo de CORS do MinIO confirmado via context7 no momento da implementação (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
5. Fazer `nestjs-api` depender de `redis` (`service_healthy`) e `minio-init` (`service_completed_successfully`); adicionar ao `.env.example` e `.env` as chaves `REDIS_HOST=redis`, `REDIS_PORT=6379`, `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_VIDEOS_BUCKET=videos`, `S3_THUMBNAILS_BUCKET=thumbnails` (nomes de serviço do Compose, nunca `localhost` para tráfego entre containers — `S3_PUBLIC_ENDPOINT` é o único endpoint voltado ao host) e atualizar a seção "Environment Startup Verification" de `nestjs-project/CLAUDE.md` com as verificações de prontidão de `redis` e `minio`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `redis` e `minio` com status `healthy` e `minio-init` com exit code `0`
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` retorna `noeviction` e `CONFIG GET appendonly` retorna `yes`
- Após o init, os buckets `videos` e `thumbnails` existem; um objeto em `thumbnails` é legível via `GET http://localhost:9000/thumbnails/<key>` sem credenciais, e um objeto em `videos` retorna `403` sem assinatura
- Um preflight `OPTIONS` de CORS em `http://localhost:9000/videos/<key>` a partir da origem pública configurada retorna `ETag` em `Access-Control-Expose-Headers`
- `docker compose exec nestjs-api npm ls @nestjs/bullmq` mostra versão `11.x`

---

### SI-03.2 — Infra: namespaces de configuração de fila, storage, upload e processamento

**Description:** Cria as factories `registerAs` e a validação Joi das novas variáveis de ambiente, seguindo a convenção herdada da Fase 01, para que fila, storage, upload e worker leiam configuração tipada.

**Technical actions:**

1. Criar `src/config/queue.config.ts` — `registerAs('queue', …)` com `host` (`REDIS_HOST`) e `port` (`REDIS_PORT`) (per `phase-03-videos/TD-01`, `phase-01-configuracao-base/TD-03`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', …)` com `endpoint` (`S3_ENDPOINT`), `publicEndpoint` (`S3_PUBLIC_ENDPOINT`), `region`, `accessKeyId`, `secretAccessKey`, `videosBucket`, `thumbnailsBucket` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
3. Criar `src/config/upload.config.ts` — `registerAs('upload', …)` com `maxVideoSizeBytes` (`MAX_VIDEO_SIZE_BYTES`, default `10737418240`), `partSizeBytes` (`UPLOAD_PART_SIZE_BYTES`, default `67108864`), `uploadUrlExpiresSeconds` (`UPLOAD_URL_EXPIRES_SECONDS`, default `3600`), `streamUrlExpiresSeconds` (`STREAM_URL_EXPIRES_SECONDS`, default `21600`) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-12`)
4. Criar `src/config/video-processing.config.ts` — `registerAs('videoProcessing', …)` com `attempts` (`VIDEO_PROCESSING_ATTEMPTS`, default `3`), `backoffDelayMs` (`VIDEO_PROCESSING_BACKOFF_MS`, default `1000`), `ffmpegTimeoutMs` (`FFMPEG_TIMEOUT_MS`) (per `phase-03-videos/TD-09`, `phase-03-videos/TD-15`)
5. Estender `src/config/env.validation.ts` com as novas chaves (URIs obrigatórias para endpoints; `UPLOAD_PART_SIZE_BYTES` entre `5242880` e `5368709120` — limites de part do S3; inteiros positivos para expiries/attempts), registrar as quatro factories no `load` do `ConfigModule.forRoot` em `AppModule` e completar `.env.example` com as chaves de upload/processamento (per `phase-01-configuracao-base/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Joi schema (`envValidationSchema`) | Unit: compilação falha com env ausente/inválida (endpoint não-URI, part size < 5 MiB, attempts ≤ 0) | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 — chaves de ambiente e serviços do Compose precisam existir

**Acceptance criteria:**

- A aplicação inicializa com o `.env.example` sem erro de validação
- A inicialização falha com erro de validação quando `S3_ENDPOINT` está ausente
- A inicialização falha com erro de validação quando `UPLOAD_PART_SIZE_BYTES` é menor que `5242880`
- Sem `MAX_VIDEO_SIZE_BYTES` no ambiente, o valor efetivo é `10737418240` (10 GiB)

---

### SI-03.3 — StorageModule com clientes S3 interno e público

**Description:** Encapsula todo acesso ao object storage em um módulo próprio, com dois clientes S3 escolhidos por audiência, para que API e worker nunca instanciem SDK diretamente.

**Technical actions:**

1. Criar `src/storage/storage.constants.ts` (tokens `S3_INTERNAL_CLIENT`, `S3_PUBLIC_CLIENT`) e `src/storage/storage.module.ts` — providers `useFactory` com `inject: [storageConfig.KEY]` criando `new S3Client({ endpoint, forcePathStyle: true, region, credentials })`: interno com `endpoint` (`S3_ENDPOINT`), público com `publicEndpoint` (`S3_PUBLIC_ENDPOINT`); exporta `StorageService` (per `phase-03-videos/TD-05`)
2. Criar `src/storage/storage.service.ts` — operações de multipart no bucket `videos` via cliente interno: `createMultipartUpload(key, contentType)`, `listParts(key, uploadId)`, `completeMultipartUpload(key, uploadId, parts)`, `headObject(key)` (retorna `ContentLength`), `deleteObject(key)` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
3. Em `StorageService`, adicionar presign por audiência com `getSignedUrl` e `expiresIn` sempre explícito: `presignUploadPart(key, uploadId, partNumber, expiresIn)` e `presignGetObject(key, expiresIn, contentDisposition?)` com o cliente **público**; `presignInternalGetObject(key, expiresIn)` com o cliente **interno** (per `phase-03-videos/TD-05`, `phase-03-videos/TD-10`, `phase-03-videos/TD-12`)
4. Em `StorageService`, adicionar `putThumbnail(key, body)` (`PutObjectCommand`, `ContentType: image/jpeg`, bucket `thumbnails`) e `getThumbnailPublicUrl(key)` (`{publicEndpoint}/{thumbnailsBucket}/{key}`, sem assinatura) (per `phase-03-videos/TD-04`)
5. Criar `src/storage/storage-keys.ts` — `videoObjectKey(videoId)` → `{videoId}/original` e `thumbnailObjectKey(videoId)` → `{videoId}.jpg` (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilação do módulo com config de teste; os dois clientes resolvem endpoints distintos | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: MinIO real — ciclo multipart create → upload part (via URL pré-assinada) → listParts → complete → headObject; presign GET com `response-content-disposition`; putThumbnail legível sem credenciais | `src/storage/storage.service.integration-spec.ts` |
| `storage-keys` | Unit: formato das chaves | `src/storage/storage-keys.spec.ts` |

**Dependencies:** SI-03.2 — `storageConfig` precisa existir

**Acceptance criteria:**

- Uma URL retornada por `presignUploadPart` tem host de `S3_PUBLIC_ENDPOINT`, e um `PUT` nela a partir do host retorna `200` com header `ETag`
- Uma URL retornada por `presignInternalGetObject` tem host `minio:9000` e é legível de dentro do container `nestjs-api`
- `completeMultipartUpload` com os `ETag`s coletados produz um objeto cujo `headObject` retorna o tamanho total das parts
- Uma URL de `presignGetObject` com disposition `attachment; filename="a.mp4"` responde com `Content-Disposition: attachment; filename="a.mp4"`
- Uma URL de `presignGetObject` responde `206` a um `GET` com `Range: bytes=0-99`
- `getThumbnailPublicUrl` aponta para um objeto em `thumbnails` legível sem assinatura

---

### SI-03.4 — Entidade Video e migration

**Description:** Modela o vídeo com status de processamento e publicação ortogonais, slug público único e metadados do ffprobe, conforme `### Data Model → Video`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com todas as colunas de `### Data Model → Video` (nomes verbatim), enums `VideoProcessingStatus` (`awaiting_upload`, `processing`, `ready`, `failed`) e `VideoPublicationStatus` (`draft`) com defaults `awaiting_upload`/`draft`, e transformer numérico para as colunas `bigint` (`declared_size_bytes`, `size_bytes`) (per `phase-03-videos/TD-14`, `phase-03-videos/TD-11`, `phase-03-videos/TD-09`)
2. Adicionar relação `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })` em `Video` e o lado inverso `@OneToMany(() => Video, (video) => video.channel) videos` em `src/channels/entities/channel.entity.ts`
3. Gerar migration `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` — tabela `videos`, tipos enum `video_processing_status` e `video_publication_status`, índice único em `slug`, índice em `channel_id`, FK para `channels(id)`; revisar `up`/`down`
4. Atualizar `cleanAllTables` em `src/test/create-test-data-source.ts` para apagar `videos` antes de `channels`, e incluir `Video` nas listas de entidades dos integration tests existentes que carregam `Channel`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `slug`, `slug` > 11 chars rejeitado, defaults `awaiting_upload`/`draft`, `description`/métricas nullable, FK `channel_id` obrigatória, `bigint` retornado como `number` | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos`; `npm run migration:revert` a remove junto com os dois tipos enum
- Inserir dois vídeos com o mesmo `slug` — o segundo insert viola a constraint unique
- Um vídeo inserido só com os campos obrigatórios tem `processing_status = 'awaiting_upload'` e `publication_status = 'draft'`
- Inserir um vídeo com `channel_id` inexistente viola a FK
- `declared_size_bytes = 10737418240` é persistido e lido de volta como o número `10737418240`

---

### SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (per `### Authorization Matrix`)

**Description:** Ao iniciar o upload, pré-cadastra o vídeo como rascunho no canal do usuário, gera o slug público e abre o multipart upload direto no storage, retornando o contrato de chunking ditado pelo servidor.

**Technical actions:**

1. Adicionar `findByUserId(userId)` em `src/channels/channels.service.ts` (lookup do canal é responsabilidade do `ChannelsModule`; exportar `ChannelsService`)
2. Criar `src/videos/video-slug.ts` — `generateVideoSlug()` = `crypto.randomBytes(8).toString('base64url')` (11 chars, só `node:crypto`) (per `phase-03-videos/TD-11`)
3. Adicionar `VideoTooLargeException` (`VIDEO_TOO_LARGE`, 400) e `UnsupportedVideoTypeException` (`UNSUPPORTED_VIDEO_TYPE`, 400) em `src/common/exceptions/domain.exception.ts`; criar `src/videos/videos.service.ts` com `createUpload(userId, dto)`: rejeita `fileSize > maxVideoSizeBytes` e `contentType` fora de `video/*`; em transação insere o `Video` (`title` = `fileName` sem extensão, `description = null`, `original_filename`, `content_type`, `declared_size_bytes`, `upload_part_size_bytes`, `upload_part_count` = ceil(`fileSize`/`partSize`)) regenerando o slug em violação unique até 3 tentativas, chama `StorageService.createMultipartUpload(videoObjectKey(id), contentType)` e grava `upload_id` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`, `phase-03-videos/TD-14`)
4. Criar `src/videos/dto/create-video-upload.dto.ts` (`fileName`, `fileSize`, `contentType` — constraints de `#### Validation Rules — Upload`) e `src/videos/dto/create-video-upload-response.dto.ts` (`videoId`, `slug`, `uploadId`, `partSize`, `partCount`); criar `src/videos/videos.controller.ts` com `POST /videos` → `201`, `@CurrentUser()`, `@ApiOperation`/`@ApiBody`/`@ApiResponse` para 201, 400 e 401 com o envelope de erro (per `openapi-docs-nestjs/TD-01`)
5. Criar `src/videos/videos.module.ts` (`TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`) e registrá-lo em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoSlug` | Unit: 11 chars, alfabeto base64url, valores distintos entre chamadas | `src/videos/video-slug.spec.ts` |
| `VideosService.createUpload` | Unit: `VIDEO_TOO_LARGE`, `UNSUPPORTED_VIDEO_TYPE`, derivação de `title`, cálculo de `partCount`, retry de slug em violação unique e desistência após 3 tentativas (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.createUpload` | Integration: DB + MinIO reais — linha persistida com `upload_id` e multipart aberto em `{videoId}/original`; rollback quando o storage falha | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 — `StorageService`; SI-03.4 — entidade `Video`

**Acceptance criteria:**

- `POST /videos` com `{ fileName: "ferias.mp4", fileSize: 104857600, contentType: "video/mp4" }` retorna `201` com `videoId`, `slug` de 11 chars, `uploadId`, `partSize` e `partCount`
- Após esse `201`, a linha em `videos` tem `title = "ferias"`, `description = null`, `publication_status = 'draft'`, `processing_status = 'awaiting_upload'` e `channel_id` = canal do usuário autenticado
- `POST /videos` com `fileSize` = `10737418241` retorna `400` com `error: "VIDEO_TOO_LARGE"`
- `POST /videos` com `contentType: "image/png"` retorna `400` com `error: "UNSUPPORTED_VIDEO_TYPE"`
- `POST /videos` sem `fileName` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem access token retorna `401`
- Dois `POST /videos` consecutivos retornam `slug`s distintos

---

### SI-03.6 — Endpoint POST /videos/{id}/upload/parts (URLs pré-assinadas de parts)

**Route:** POST /videos/{id}/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts-presign.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Entrega ao dono do vídeo, em lotes, URLs pré-assinadas de `UploadPart` para que os bytes vão direto ao storage sem passar pela API.

**Technical actions:**

1. Adicionar `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `InvalidVideoStateException` (`INVALID_VIDEO_STATE`, 409) e `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 400) em `src/common/exceptions/domain.exception.ts`
2. Adicionar em `VideosService` o helper `findOwnedById(videoId, userId)` — busca o vídeo cujo `channel_id` é o canal do usuário; ausente ou de outro canal → `VIDEO_NOT_FOUND` (não revela existência) — e `assertAwaitingUpload(video)` → `INVALID_VIDEO_STATE` (per `phase-03-videos/TD-14`)
3. Adicionar `VideosService.presignParts(videoId, userId, partNumbers)` — rejeita qualquer número > `upload_part_count` com `INVALID_PART_NUMBER` e chama `StorageService.presignUploadPart` para cada part com `expiresIn = uploadUrlExpiresSeconds`; retorna `{ parts: [{ partNumber, url }], expiresIn }` na ordem pedida (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
4. Criar `src/videos/dto/presign-parts.dto.ts` (`partNumbers`: array não vazio, inteiros únicos ≥ 1) e `src/videos/dto/presign-parts-response.dto.ts`; adicionar a rota em `VideosController` com `ParseUUIDPipe` em `id`, `@HttpCode(200)` e decoradores OpenAPI para 200, 400, 401, 404 e 409

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedById` / `presignParts` | Unit: não-dono → `VIDEO_NOT_FOUND`; status ≠ `awaiting_upload` → `INVALID_VIDEO_STATE`; part > `upload_part_count` → `INVALID_PART_NUMBER`; `expiresIn` repassado (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.presignParts` | Integration: DB + MinIO reais — URL retornada aceita `PUT` da part e devolve `ETag` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — vídeo pré-cadastrado com `upload_id` e `VideosController`

**Acceptance criteria:**

- `POST /videos/{id}/upload/parts` com `{ partNumbers: [1, 2] }` pelo dono retorna `200` com duas entradas `{ partNumber, url }` na ordem pedida e `expiresIn` = `UPLOAD_URL_EXPIRES_SECONDS`
- Um `PUT` de bytes na `url` retornada responde `200` com header `ETag`
- A mesma chamada feita por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `partNumbers` contendo `upload_part_count + 1` retorna `400` com `error: "INVALID_PART_NUMBER"`
- Para um vídeo em `processing`, a chamada retorna `409` com `error: "INVALID_VIDEO_STATE"`
- `id` que não é UUID ou `partNumbers: []` retorna `400` com `error: "VALIDATION_ERROR"`

---

### SI-03.7 — Endpoint GET /videos/{id}/upload/parts (retomada do upload)

**Route:** GET /videos/{id}/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts-list.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Permite ao cliente retomar um upload interrompido consultando quais parts já chegaram ao storage (`ListParts`).

**Technical actions:**

1. Adicionar `VideosService.listUploadedParts(videoId, userId)` — reutiliza `findOwnedById` + `assertAwaitingUpload`, chama `StorageService.listParts(videoObjectKey(id), upload_id)` e retorna `{ parts: [{ partNumber, etag, size }], partSize, partCount }` ordenado por `partNumber` (per `phase-03-videos/TD-06`)
2. Criar `src/videos/dto/uploaded-parts-response.dto.ts` e adicionar a rota em `VideosController` com `ParseUUIDPipe` e decoradores OpenAPI para 200, 400, 401, 404 e 409

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.listUploadedParts` | Integration: DB + MinIO reais — lista vazia antes de qualquer `PUT`; após subir as parts 1 e 3, retorna exatamente essas com `etag` e `size` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 — helpers de posse/estado e exceções de vídeo

**Acceptance criteria:**

- `GET /videos/{id}/upload/parts` pelo dono antes de qualquer part retorna `200` com `parts: []`, `partSize` e `partCount`
- Depois de subir as parts 1 e 3, a chamada retorna `200` com `parts` contendo apenas `partNumber` 1 e 3, cada uma com `etag` e `size`
- A mesma chamada por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Para um vídeo em `ready`, a chamada retorna `409` com `error: "INVALID_VIDEO_STATE"`

---

### SI-03.8 — Infra: fila `video-processing` (BullModule)

**Description:** Conecta a aplicação ao Redis e registra a fila `video-processing` com seu contrato de job, compartilhado entre produtor (API) e consumidor (worker).

**Technical actions:**

1. Criar `src/queue/queue.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process'` e o tipo `VideoProcessingJobData = { videoId: string }` (payload só com `videoId`; o DB é a fonte da verdade) (per `phase-03-videos/TD-01`)
2. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port } }) })`, importado por `AppModule` (e depois pelo `WorkerModule`) (per `phase-03-videos/TD-01`)
3. Em `VideosModule`, adicionar `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` — sem nenhum `@Processor` no grafo do `AppModule` (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilação do módulo com config de teste; a fila `video-processing` é injetável via `getQueueToken` | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.2 — `queueConfig`; SI-03.5 — `VideosModule`

**Acceptance criteria:**

- A API inicializa conectada ao Redis `redis:6379` sem erros de conexão no log
- Com o Redis parado, a inicialização registra erro de conexão com o host `redis` (nunca `localhost`)
- O grafo de módulos do `AppModule` não contém nenhum provider `@Processor`

---

### SI-03.9 — Endpoint POST /videos/{id}/upload/complete (conclusão + disparo do processamento)

**Route:** POST /videos/{id}/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Conclui o multipart, verifica o tamanho real, muda o vídeo para `processing` e só então enfileira o job — a chamada explícita do cliente é o gatilho do processamento.

**Technical actions:**

1. Adicionar `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, 400) em `src/common/exceptions/domain.exception.ts`; em `StorageService.completeMultipartUpload`, traduzir os erros S3 `InvalidPart`, `InvalidPartOrder` e `NoSuchUpload` para essa exceção (per `phase-03-videos/TD-08`)
2. Adicionar `VideosService.completeUpload(videoId, userId, parts)` na ordem obrigatória: `findOwnedById` + `assertAwaitingUpload` → `completeMultipartUpload` → `headObject`; se `ContentLength > maxVideoSizeBytes`, `deleteObject`, grava `processing_status = 'failed'` + `processing_error` e lança `VIDEO_TOO_LARGE` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
3. No caminho feliz, gravar e **commitar** `processing_status = 'processing'` e só depois `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId, attempts, backoff: { type: 'exponential', delay: backoffDelayMs } })` via `@InjectQueue(VIDEO_PROCESSING_QUEUE)`, sem `removeOnComplete`/`removeOnFail` para preservar a deduplicação por `jobId` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-15`, `phase-03-videos/TD-01`)
4. Criar `src/videos/dto/complete-upload.dto.ts` (`parts`: array não vazio de `{ partNumber, etag }` com `@ValidateNested` + `@Type`, `partNumber` único ≥ 1, `etag` não vazio) e `src/videos/dto/complete-upload-response.dto.ts` (`videoId`, `slug`, `processingStatus`); adicionar a rota em `VideosController` com `@HttpCode(202)` e decoradores OpenAPI para 202, 400, 401, 404 e 409

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: status commitado antes do `queue.add`; opções do job (`jobId`, `attempts`, `backoff`); `VIDEO_TOO_LARGE` apaga o objeto e marca `failed`; erro S3 → `INVALID_UPLOAD_PARTS`; nenhum enqueue em caminho de erro (mock repo/storage/queue) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: DB + MinIO + Redis reais — após o complete, o objeto existe em `{videoId}/original`, o status é `processing` e há um job com id = `videoId` na fila | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.7 — fluxo de parts completo; SI-03.8 — fila registrada

**Acceptance criteria:**

- Após subir todas as parts, `POST /videos/{id}/upload/complete` com os `{ partNumber, etag }` retorna `202` com `videoId`, `slug` e `processingStatus: "processing"`
- Depois desse `202`, `videos.processing_status` é `processing` e a fila `video-processing` contém um job com id igual ao `videoId` e payload `{ videoId }`
- Uma segunda chamada de complete para o mesmo vídeo retorna `409` com `error: "INVALID_VIDEO_STATE"` e não cria um segundo job
- Um `etag` que não corresponde à part enviada retorna `400` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo continua em `awaiting_upload`
- Quando o tamanho real concluído excede `MAX_VIDEO_SIZE_BYTES` (teste com limite reduzido), a chamada retorna `400` com `error: "VIDEO_TOO_LARGE"`, o objeto é removido e o vídeo fica `failed` com `processing_error` preenchido
- A chamada feita por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.10 — FfmpegService (ffprobe + extração de thumbnail)

**Description:** Wrapper tipado e sem shell sobre os binários do sistema `ffprobe`/`ffmpeg`, que extrai os metadados persistidos e gera a thumbnail JPEG a partir de uma URL de entrada.

**Technical actions:**

1. Adicionar `ffmpeg` ao `apt install` de `nestjs-project/Dockerfile.dev` (imagem compartilhada por `nestjs-api`, pelos testes e pelo futuro `video-worker`) — pacote do SO, sem `fluent-ffmpeg` nem binários via npm (per `phase-03-videos/TD-09`)
2. Criar `src/video-processing/ffmpeg/ffmpeg.service.ts` — `probe(inputUrl)` roda `execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputUrl])` com timeout `ffmpegTimeoutMs` e mapeia para `{ duration, width, height, video_codec, audio_codec, size_bytes, mime }` (`audio_codec = null` sem trilha de áudio); sem stream de vídeo → erro tipado `NoVideoStreamError` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`)
3. Adicionar `computeThumbnailTimestamp(duration)` — ~10% da duração, com clamp ao comprimento do vídeo (vídeos muito curtos ainda produzem frame) (per `phase-03-videos/TD-09`)
4. Adicionar `extractThumbnail(inputUrl, atSeconds)` — `execFile('ffmpeg', ['-ss', t, '-i', inputUrl, '-frames:v', '1', '-vf', 'scale=1280:-2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'])` retornando o JPEG como `Buffer`, sem disco temporário (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`)
5. Criar `src/video-processing/video-processing.module.ts` provendo `FfmpegService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Unit: argumentos passados ao `execFile` (array, sem shell), parse do JSON do ffprobe incluindo vídeo sem áudio e ausência de stream de vídeo, `computeThumbnailTimestamp` com clamp (mock `execFile`) | `src/video-processing/ffmpeg/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration: binários reais — fixture gerada no `beforeAll` com `ffmpeg -f lavfi` (com e sem áudio) servida por URL pré-assinada interna do MinIO; `probe` retorna os metadados esperados; `extractThumbnail` retorna JPEG com largura 1280 | `src/video-processing/ffmpeg/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — `videoProcessingConfig`; SI-03.3 — URL interna pré-assinada para os testes de integração

**Acceptance criteria:**

- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` saem com código `0`
- `probe` sobre um vídeo 1920×1080 H.264/AAC de 5 s retorna `width = 1920`, `height = 1080`, `video_codec = "h264"`, `audio_codec = "aac"` e `duration` ≈ 5
- `probe` sobre um vídeo sem trilha de áudio retorna `audio_codec = null`
- `probe` sobre um arquivo que não é vídeo lança `NoVideoStreamError`
- `extractThumbnail` sobre um vídeo de 1 s produz um JPEG de largura 1280 com proporção preservada

---

### SI-03.11 — Infra: entrypoint do worker e serviço `video-worker`

**Description:** Cria o segundo entrypoint do mesmo codebase — um application context sem HTTP — e o serviço `video-worker` no Compose, escalável de forma independente da API.

**Technical actions:**

1. Extrair `ConfigModule.forRoot(...)` e `TypeOrmModule.forRootAsync(...)` de `AppModule` para `src/config/app-config.module.ts` e `src/database/database.module.ts`, reutilizados por `AppModule` e `WorkerModule` — uma única fonte de parâmetros de conexão (per convenção herdada da Fase 01, `phase-01-configuracao-base/TD-04`)
2. Criar `src/worker.module.ts` — importa a config compartilhada, `DatabaseModule`, `QueueModule`, `StorageModule` e `VideoProcessingModule`; nenhum controller, guard ou throttler (per `phase-03-videos/TD-02`)
3. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `app.enableShutdownHooks()` para fechar o worker BullMQ no `SIGTERM` (per `phase-03-videos/TD-02`)
4. Adicionar scripts `start:worker` (`node dist/worker`) e `start:worker:dev` (`nest start --watch --entryFile worker`) em `package.json`
5. Adicionar o serviço `video-worker` em `compose.yaml` (mesmo build `Dockerfile.dev`, mesmo volume e `.env`, `depends_on` `db`, `redis`, `minio-init`) e documentar em `nestjs-project/CLAUDE.md` como iniciá-lo (`docker compose exec video-worker npm run start:worker:dev`) e escalá-lo (`--scale video-worker=N`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilação do módulo; o grafo não registra controllers | `src/worker.module.spec.ts` |
| `DatabaseModule` / `AppConfigModule` | Unit: compilação dos módulos extraídos | `src/database/database.module.spec.ts` |

**Dependencies:** SI-03.8 — `QueueModule`; SI-03.10 — `VideoProcessingModule` e ffmpeg na imagem

**Acceptance criteria:**

- `docker compose up -d` sobe `video-worker` com status `running`
- `docker compose exec video-worker npm run start:worker:dev` inicia o worker sem abrir porta HTTP e sem erros de conexão com `db` e `redis`
- Um `SIGTERM` no processo do worker encerra-o sem erros e sem deixar jobs ativos travados
- Após a extração dos módulos de config e banco, `POST /auth/login` com credenciais válidas continua retornando `200` com tokens

---

### SI-03.12 — VideoProcessor (processamento, idempotência e falha final)

**Description:** Consome os jobs de `video-processing` no worker: extrai metadados, gera e publica a thumbnail, marca o vídeo como `ready`, e registra `failed` com o motivo quando a falha é permanente ou as tentativas se esgotam.

**Technical actions:**

1. Criar `src/video-processing/video-processing.service.ts` com `process(videoId)`: carrega o vídeo; se `ready`, retorna sem efeito (idempotência); se não estiver em `processing`, retorna sem efeito; presigna GET **interno** de `videoObjectKey(id)` e o passa ao ffprobe/ffmpeg como `-i` (sem download completo) (per `phase-03-videos/TD-10`, `phase-03-videos/TD-15`)
2. Em `process`, persistir `duration`, `width`, `height`, `video_codec`, `audio_codec`, `size_bytes`, `mime`; gerar a thumbnail em `computeThumbnailTimestamp(duration)`, enviar via `putThumbnail(thumbnailObjectKey(id))` (chave determinística — reprocessar sobrescreve), gravar `thumbnail_key` e `processing_status = 'ready'`; `NoVideoStreamError` ou mídia rejeitada pelo ffprobe/ffmpeg → `throw new UnrecoverableError(...)`; demais erros propagam para retry (per `phase-03-videos/TD-09`, `phase-03-videos/TD-15`)
3. Adicionar `markFailed(videoId, message)` — grava `processing_status = 'failed'` e `processing_error` somente se o vídeo ainda estiver em `processing` (per `phase-03-videos/TD-14`, `phase-03-videos/TD-15`)
4. Criar `src/video-processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE) class VideoProcessor extends WorkerHost`; `process(job: Job<VideoProcessingJobData>)` delega a `VideoProcessingService.process`; `@OnWorkerEvent('failed')` chama `markFailed` quando `err instanceof UnrecoverableError` ou `job.attemptsMade >= job.opts.attempts` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-15`)
5. Em `VideoProcessingModule`, registrar `TypeOrmModule.forFeature([Video])`, `StorageModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, `VideoProcessingService` e `VideoProcessor` — módulo importado apenas pelo `WorkerModule` (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: skip quando `ready`; skip fora de `processing`; `NoVideoStreamError` → `UnrecoverableError`; erro transitório propaga como `Error`; `markFailed` só age em `processing` (mock repo/storage/ffmpeg) | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration: DB + MinIO + ffmpeg reais — vídeo fixture enviado a `videos/{id}/original` termina `ready` com metadados e thumbnail legível publicamente; arquivo não-vídeo lança `UnrecoverableError`; segunda execução não altera o resultado | `src/video-processing/video-processing.service.integration-spec.ts` |
| `VideoProcessor` | Unit: delega `job.data.videoId`; `failed` com `UnrecoverableError` chama `markFailed`; `failed` com tentativas restantes não chama | `src/video-processing/video.processor.spec.ts` |

**Dependencies:** SI-03.9 — jobs enfileirados no complete; SI-03.11 — worker entrypoint

**Acceptance criteria:**

- Após o complete de um vídeo válido, com o worker rodando, `videos.processing_status` passa a `ready` com `duration`, `width`, `height`, `video_codec`, `size_bytes` e `mime` preenchidos e `thumbnail_key = "{videoId}.jpg"`
- A thumbnail em `http://localhost:9000/thumbnails/{videoId}.jpg` é um JPEG de largura 1280 legível sem credenciais
- Um upload concluído de um arquivo que não é vídeo termina com `processing_status = 'failed'` e `processing_error` preenchido, sem novas tentativas
- Uma falha transitória (storage indisponível durante o job) é retentada com backoff exponencial e, esgotadas as tentativas, o vídeo termina `failed` com `processing_error`
- Reenfileirar manualmente um job de um vídeo já `ready` não altera seus metadados nem seu status

---

### SI-03.13 — Endpoint GET /videos/{slug}/stream (streaming via redirect)

**Route:** GET /videos/{slug}/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Endpoint estável de reprodução pela URL única do vídeo: a API autoriza e redireciona para uma URL pré-assinada, e o storage atende `Range`/`206` nativamente, sem bytes passando pela API.

**Technical actions:**

1. Adicionar `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) em `src/common/exceptions/domain.exception.ts`
2. Adicionar em `VideosService` `findOwnedReadyBySlug(slug, userId)` — ausente ou de outro canal → `VIDEO_NOT_FOUND`; `processing_status` ≠ `ready` → `VIDEO_NOT_READY` (owner-only enquanto rascunho) (per `phase-03-videos/TD-13`)
3. Adicionar `VideosService.getStreamUrl(slug, userId)` — `StorageService.presignGetObject(videoObjectKey(id), streamUrlExpiresSeconds)` com cliente público e sem `ResponseContentDisposition` (inline) (per `phase-03-videos/TD-12`, `phase-03-videos/TD-05`)
4. Criar `src/videos/dto/video-slug-param.dto.ts` (`slug` com `@Matches(/^[A-Za-z0-9_-]{11}$/)`, validado pelo `ValidationPipe` global → `VALIDATION_ERROR`) e adicionar a rota em `VideosController` respondendo `302` com `Location` = URL pré-assinada, com decoradores OpenAPI para 302, 400, 401, 404 e 409

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedReadyBySlug` / `getStreamUrl` | Unit: não-dono → `VIDEO_NOT_FOUND`; `processing`/`failed`/`awaiting_upload` → `VIDEO_NOT_READY`; `expiresIn` = `streamUrlExpiresSeconds`; nenhuma disposition (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.getStreamUrl` | Integration: DB + MinIO reais — a URL retornada responde `206` a `Range: bytes=0-1023` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.12 — vídeos chegam a `ready`

**Acceptance criteria:**

- `GET /videos/{slug}/stream` pelo dono de um vídeo `ready` retorna `302` com `Location` apontando para `S3_PUBLIC_ENDPOINT`
- Um `GET` na `Location` com `Range: bytes=0-1023` retorna `206` com `Content-Range` e 1024 bytes
- Para um vídeo em `processing`, a chamada retorna `409` com `error: "VIDEO_NOT_READY"`
- A chamada por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`
- A chamada sem access token retorna `401`
- `slug` com formato inválido (ex.: 5 chars) retorna `400` com `error: "VALIDATION_ERROR"`

---

### SI-03.14 — Endpoint GET /videos/{slug}/download (download via redirect)

**Route:** GET /videos/{slug}/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Mesmo mecanismo do streaming, com `Content-Disposition: attachment` na URL pré-assinada, para que o navegador baixe o arquivo com o nome original.

**Technical actions:**

1. Criar `src/videos/content-disposition.ts` — `buildAttachmentDisposition(filename)` → `attachment; filename="<nome>"`, removendo aspas, barras invertidas e caracteres de controle do nome (per `phase-03-videos/TD-12`)
2. Adicionar `VideosService.getDownloadUrl(slug, userId)` — reutiliza `findOwnedReadyBySlug` e chama `StorageService.presignGetObject(videoObjectKey(id), streamUrlExpiresSeconds, buildAttachmentDisposition(original_filename))` (enviado como `ResponseContentDisposition`) (per `phase-03-videos/TD-12`, `phase-03-videos/TD-13`)
3. Adicionar a rota em `VideosController` reutilizando `VideoSlugParamDto`, respondendo `302` com `Location`, e decoradores OpenAPI para 302, 400, 401, 404 e 409

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildAttachmentDisposition` | Unit: nome simples; nome com aspas/controle sanitizado | `src/videos/content-disposition.spec.ts` |
| `VideosService.getDownloadUrl` | Integration: DB + MinIO reais — a URL retornada responde com `Content-Disposition: attachment; filename="<original_filename>"` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.13 — `findOwnedReadyBySlug` e `VideoSlugParamDto`

**Acceptance criteria:**

- `GET /videos/{slug}/download` pelo dono de um vídeo `ready` retorna `302`, e um `GET` na `Location` responde `200` com `Content-Disposition: attachment; filename="ferias.mp4"` e o arquivo completo
- Um `original_filename` contendo `"` gera um header `Content-Disposition` bem formado, sem a aspa
- Para um vídeo em `processing`, a chamada retorna `409` com `error: "VIDEO_NOT_READY"`
- A chamada por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.15 — Regenerar a especificação OpenAPI commitada

**Description:** Atualiza o `openapi.json` commitado (e os metadados do plugin) com as seis novas rotas de vídeo, mantendo a fundação de codegen do frontend em dia.

**Technical actions:**

1. Regenerar `src/metadata.ts` (plugin CLI do `@nestjs/swagger`, via `npm run build`) e `nestjs-project/openapi.json` via `npm run openapi:export`, e commitar ambos (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`)
2. Estender `src/openapi-export.integration-spec.ts` para verificar a presença das seis operações de vídeo com seus status documentados

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `exportSpec` | Integration: operações `POST /videos`, `POST`/`GET /videos/{id}/upload/parts`, `POST /videos/{id}/upload/complete`, `GET /videos/{slug}/stream` e `GET /videos/{slug}/download` presentes com respostas de erro no envelope `{ statusCode, error, message }` | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.14 — todas as rotas de vídeo existem

**Acceptance criteria:**

- `openapi.json` commitado contém as seis operações de vídeo, com as respostas `302` de stream/download e `202` de complete documentadas
- `GET /api/docs` em dev lista as operações de vídeo sob o esquema de segurança `access-token`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier (`videoId`); used in storage keys and as BullMQ `jobId` — never exposed in public URLs (per phase-03-videos/TD-04, TD-11) |
| slug | varchar(11) | unique, not null | Public URL identifier — 11-char base64url from `crypto.randomBytes(8)`; regenerated with bounded retries on unique violation (per phase-03-videos/TD-11). Generated at pre-registration |
| channel_id | uuid | FK → channels.id, not null | Owning channel = channel of the authenticated user (per phase-03-videos/TD-14 revision) |
| title | varchar(255) | not null | Default = original file name without extension (per phase-03-videos/TD-14 revision). Not editable in Phase 03 |
| description | text | nullable | Always `null` in Phase 03 (per phase-03-videos/TD-14 revision) |
| original_filename | varchar(255) | not null | `fileName` declared at upload creation (per phase-03-videos/TD-07); source for the `title` default and the download `filename` (per phase-03-videos/TD-12) |
| content_type | varchar(255) | not null | `contentType` declared at creation; must match `video/*` (per phase-03-videos/TD-07) — first filter only, ffprobe is authoritative |
| declared_size_bytes | bigint | not null | `fileSize` declared at creation; ≤ `MAX_VIDEO_SIZE_BYTES` (per phase-03-videos/TD-07). TypeORM returns `bigint` as `string` — map with a numeric transformer |
| upload_part_size_bytes | integer | not null | `partSize` dictated at creation from `UPLOAD_PART_SIZE_BYTES`; persisted so `partCount` stays stable for the upload even if env changes (per phase-03-videos/TD-07) |
| upload_part_count | integer | not null | `partCount` = ceil(`declared_size_bytes` / `upload_part_size_bytes`); only part numbers `1..upload_part_count` are presigned (per phase-03-videos/TD-07) |
| upload_id | varchar(1024) | nullable | S3 multipart `UploadId` from `CreateMultipartUpload` (per phase-03-videos/TD-06) |
| publication_status | enum `video_publication_status` | not null, default `'draft'`, values: `'draft'` | Phase 04 adds `published` (per phase-03-videos/TD-14) |
| processing_status | enum `video_processing_status` | not null, default `'awaiting_upload'`, values: `'awaiting_upload'`, `'processing'`, `'ready'`, `'failed'` | Driven by upload completion and the worker (per phase-03-videos/TD-14) |
| processing_error | text | nullable | Failure detail recorded on the final failed transition (per phase-03-videos/TD-14, TD-15) |
| duration | numeric(12,3) | nullable | Seconds, from ffprobe `format.duration` (per phase-03-videos/TD-09 revision) |
| width | integer | nullable | From ffprobe video stream (per phase-03-videos/TD-09 revision) |
| height | integer | nullable | From ffprobe video stream (per phase-03-videos/TD-09 revision) |
| video_codec | varchar(50) | nullable | From ffprobe video stream `codec_name` (per phase-03-videos/TD-09 revision) |
| audio_codec | varchar(50) | nullable | From ffprobe audio stream `codec_name`; stays `null` when the video has no audio track (per phase-03-videos/TD-09 revision) |
| size_bytes | bigint | nullable | Real size from ffprobe `format.size` (per phase-03-videos/TD-09 revision); numeric transformer as above |
| mime | varchar(100) | nullable | Container/mime derived from ffprobe `format.format_name` (per phase-03-videos/TD-09 revision) |
| thumbnail_key | varchar(255) | nullable | `{videoId}.jpg` in the public `thumbnails` bucket; set when processing succeeds (per phase-03-videos/TD-04) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`); Channel → Video (one-to-many, inverse side, no cascade)
**Indexes:** `(slug)` — unique; `(channel_id)` — FK lookup

**Status transitions (service-enforced, per phase-03-videos/TD-14):**

| From | To | Actor | Trigger |
|------|----|-------|---------|
| — | `awaiting_upload` | API | `POST /videos` (pre-registration) |
| `awaiting_upload` | `processing` | API | `POST /videos/{id}/upload/complete` succeeds |
| `processing` | `ready` | Worker | ffprobe + thumbnail succeed |
| `processing` | `failed` | Worker | Final failure (`UnrecoverableError` or attempts exhausted) — per phase-03-videos/TD-15 |

Any other transition is rejected. `publication_status` stays `draft` throughout Phase 03.

**Storage layout (per phase-03-videos/TD-04):**

| Bucket | Access | Object key | Content |
|--------|--------|------------|---------|
| `videos` | private — presigned URLs only | `{videoId}/original` | Uploaded source video (multipart target) |
| `thumbnails` | anonymous read (`mc anonymous set download`) | `{videoId}.jpg` | JPEG thumbnail, width 1280, aspect ratio preserved (per phase-03-videos/TD-09 revision) |

Keys use `videoId` (UUID), never the public `slug`.

### API Contracts

All endpoints require a valid access token (`Authorization: Bearer <access_token>`) via the inherited global `JwtAuthGuard`. Error bodies follow the inherited envelope `{ statusCode, error, message }` (per phase-02-auth/TD-07). Every endpoint carries explicit `@ApiOperation` / `@ApiResponse` / `@ApiBody` / `@ApiParam` decorators (per openapi-docs-nestjs/TD-01 revision). Video bytes never cross the API — every byte-carrying request goes straight to storage through presigned URLs signed with the public S3 client (per phase-03-videos/TD-05, TD-06, TD-12).

#### POST /videos (SI-03.5)

Pre-registers the draft and starts the S3 multipart upload (per phase-03-videos/TD-06, TD-07, TD-11, TD-14).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- fileName: string, required — non-empty, max 255 characters
- fileSize: integer, required — ≥ 1; ≤ `MAX_VIDEO_SIZE_BYTES` enforced in the service (10 GiB)
- contentType: string, required — must match `video/*`, enforced in the service

**Response 201:**
- videoId: string (uuid)
- slug: string (11-char base64url)
- uploadId: string
- partSize: integer — bytes, from `UPLOAD_PART_SIZE_BYTES`
- partCount: integer — ceil(`fileSize` / `partSize`)

**Side effects:** inserts `videos` row (`publication_status = 'draft'`, `processing_status = 'awaiting_upload'`, `title` = `fileName` without extension, `description = null`, `channel_id` = caller's channel); calls `CreateMultipartUpload` on bucket `videos`, key `{videoId}/original`, with `ContentType = contentType`.

**Error responses:**
- 400 VIDEO_TOO_LARGE: when `fileSize` > `MAX_VIDEO_SIZE_BYTES`
- 400 UNSUPPORTED_VIDEO_TYPE: when `contentType` does not match `video/*`
- 400 VALIDATION_ERROR: when the request body fails schema validation
- 401 Unauthorized: missing/invalid access token — inherited `JwtAuthGuard` (Nest default `UnauthorizedException` body, no domain code)

---

#### POST /videos/{id}/upload/parts (SI-03.6)

Presigns `UploadPart` URLs for a batch of part numbers (per phase-03-videos/TD-06, TD-07). The client `PUT`s each part directly to the returned URL and reads the `ETag` response header (exposed via storage CORS — per phase-03-videos/TD-05).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request path parameters:**
- id: string (uuid), required — `videoId`

**Request body:**
- partNumbers: integer[], required — non-empty, unique values, each ≥ 1; each ≤ the video's `upload_part_count` enforced in the service

**Response 200:**
- parts: `{ partNumber: integer, url: string }[]` — one presigned `PUT` URL per requested part, in request order
- expiresIn: integer — seconds (`UPLOAD_URL_EXPIRES_SECONDS`, passed explicitly as `expiresIn` to `getSignedUrl`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `id` exists or it does not belong to the caller's channel
- 409 INVALID_VIDEO_STATE: when `processing_status` ≠ `awaiting_upload`
- 400 INVALID_PART_NUMBER: when any part number is > `upload_part_count`
- 400 VALIDATION_ERROR: when `id` is not a UUID or the body fails schema validation
- 401 Unauthorized: missing/invalid access token (inherited `JwtAuthGuard`)

---

#### GET /videos/{id}/upload/parts (SI-03.7)

Lists parts already stored, for client-side resume (`ListParts` — per phase-03-videos/TD-06).

**Request headers:**
- Authorization: Bearer <access_token>

**Request path parameters:**
- id: string (uuid), required — `videoId`

**Response 200:**
- parts: `{ partNumber: integer, etag: string, size: integer }[]` — ordered by `partNumber`; empty array when nothing landed yet
- partSize: integer
- partCount: integer

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `id` exists or it does not belong to the caller's channel
- 409 INVALID_VIDEO_STATE: when `processing_status` ≠ `awaiting_upload`
- 400 VALIDATION_ERROR: when `id` is not a UUID
- 401 Unauthorized: missing/invalid access token (inherited `JwtAuthGuard`)

---

#### POST /videos/{id}/upload/complete (SI-03.9)

Finishes the multipart upload and triggers processing (per phase-03-videos/TD-07, TD-08, TD-14). Order is mandatory: `CompleteMultipartUpload` → `HeadObject` size check → set `processing_status = 'processing'` and **commit** → enqueue `{ videoId }` with `jobId = videoId`.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request path parameters:**
- id: string (uuid), required — `videoId`

**Request body:**
- parts: `{ partNumber: integer, etag: string }[]`, required — non-empty; `partNumber` ≥ 1, unique; `etag` non-empty string

**Response 202:**
- videoId: string (uuid)
- slug: string
- processingStatus: `'processing'`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `id` exists or it does not belong to the caller's channel
- 409 INVALID_VIDEO_STATE: when `processing_status` ≠ `awaiting_upload`
- 400 INVALID_UPLOAD_PARTS: when storage rejects the part list (`InvalidPart` / `InvalidPartOrder` / `NoSuchUpload`)
- 400 VIDEO_TOO_LARGE: when `HeadObject` `ContentLength` > `MAX_VIDEO_SIZE_BYTES` — the stored object is deleted and the video moves to `failed` with `processing_error` set
- 400 VALIDATION_ERROR: when `id` is not a UUID or the body fails schema validation
- 401 Unauthorized: missing/invalid access token (inherited `JwtAuthGuard`)

---

#### GET /videos/{slug}/stream (SI-03.13)

Authorizes and redirects to a presigned `GetObject` URL; storage serves `Range` → `206` natively (per phase-03-videos/TD-12, TD-13).

**Request headers:**
- Authorization: Bearer <access_token>

**Request path parameters:**
- slug: string, required — 11-char base64url (`^[A-Za-z0-9_-]{11}$`)

**Response 302:**
- Location: presigned `GET` URL for bucket `videos`, key `{videoId}/original`, signed with the public client, no `ResponseContentDisposition` (inline), `expiresIn = STREAM_URL_EXPIRES_SECONDS`
- Body: empty

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `slug` exists or it does not belong to the caller's channel
- 409 VIDEO_NOT_READY: when `processing_status` ≠ `ready`
- 400 VALIDATION_ERROR: when `slug` does not match the format
- 401 Unauthorized: missing/invalid access token (inherited `JwtAuthGuard`)

---

#### GET /videos/{slug}/download (SI-03.14)

Same as stream, with an attachment disposition (per phase-03-videos/TD-12, TD-13).

**Request headers:**
- Authorization: Bearer <access_token>

**Request path parameters:**
- slug: string, required — 11-char base64url (`^[A-Za-z0-9_-]{11}$`)

**Response 302:**
- Location: presigned `GET` URL as in `/stream`, plus `ResponseContentDisposition: 'attachment; filename="<original_filename>"'` (filename sanitized: quotes and control characters stripped)
- Body: empty

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `slug` exists or it does not belong to the caller's channel
- 409 VIDEO_NOT_READY: when `processing_status` ≠ `ready`
- 400 VALIDATION_ERROR: when `slug` does not match the format
- 401 Unauthorized: missing/invalid access token (inherited `JwtAuthGuard`)

---

#### Validation Rules — Upload

| Field | Rule | Layer |
|-------|------|-------|
| fileName | required, string, 1–255 characters | DTO (`class-validator`) |
| fileSize | required, integer, ≥ 1 | DTO |
| fileSize | ≤ `MAX_VIDEO_SIZE_BYTES` (10 GiB = 10737418240) | Service → `VIDEO_TOO_LARGE` (re-checked on real size via `HeadObject` at completion) |
| contentType | required, string | DTO |
| contentType | matches `video/*` | Service → `UNSUPPORTED_VIDEO_TYPE` (first filter only; ffprobe in the worker is authoritative — per phase-03-videos/TD-07) |
| partNumbers | required, non-empty array, unique integers ≥ 1 | DTO |
| partNumbers[] | ≤ `upload_part_count` | Service → `INVALID_PART_NUMBER` |
| parts | required, non-empty array of `{ partNumber, etag }`, unique `partNumber` ≥ 1, non-empty `etag` | DTO (`@ValidateNested` + `@Type`) |
| id (path) | UUID | `ParseUUIDPipe` → 400 `VALIDATION_ERROR` |
| slug (path) | `^[A-Za-z0-9_-]{11}$` | Pipe/DTO → 400 `VALIDATION_ERROR` |

---

### Authorization Matrix

"Owner" = the video's `channel_id` equals the channel of the authenticated user. Non-owners get `404 VIDEO_NOT_FOUND` (existence is not revealed). Per phase-03-videos/TD-13, stream/download are owner-only while every video is a draft; Phase 04 relaxes this for published/unlisted videos and Phase 05 adds `@Public()` access.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner | Extra state condition |
|----------|-----------|---------------------------|-------|-----------------------|
| POST /videos | ✗ (401) | ✓ | — | Video is created in the caller's channel |
| POST /videos/{id}/upload/parts | ✗ (401) | ✗ (404) | ✓ | `processing_status = 'awaiting_upload'` |
| GET /videos/{id}/upload/parts | ✗ (401) | ✗ (404) | ✓ | `processing_status = 'awaiting_upload'` |
| POST /videos/{id}/upload/complete | ✗ (401) | ✗ (404) | ✓ | `processing_status = 'awaiting_upload'` |
| GET /videos/{slug}/stream | ✗ (401) | ✗ (404) | ✓ | `processing_status = 'ready'` |
| GET /videos/{slug}/download | ✗ (401) | ✗ (404) | ✓ | `processing_status = 'ready'` |

Storage-side access (not HTTP endpoints of the API):

| Resource | Access |
|----------|--------|
| `videos` bucket objects | Private — reachable only via presigned URLs issued by the endpoints above (per phase-03-videos/TD-04, TD-12) |
| `thumbnails` bucket objects | Anonymous read (per phase-03-videos/TD-04) |

---

### Error Catalog

**Error response format:** inherited from phase-02-auth — `{ statusCode, error, message }`, `error` carrying the domain code (per phase-02-auth/TD-07). New codes are `DomainException` subclasses in `src/common/exceptions/domain.exception.ts`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | `id`/`slug` does not exist, or the video does not belong to the caller's channel |
| INVALID_VIDEO_STATE | 409 | Video is not awaiting upload | Upload endpoints (`/upload/parts`, `/upload/complete`) when `processing_status` ≠ `awaiting_upload` (per phase-03-videos/TD-14) |
| VIDEO_NOT_READY | 409 | Video is not ready | Stream/download when `processing_status` ≠ `ready` (per phase-03-videos/TD-13) |
| VIDEO_TOO_LARGE | 400 | Video exceeds the maximum allowed size | Declared `fileSize` at `POST /videos`, or real `ContentLength` at completion, > `MAX_VIDEO_SIZE_BYTES` (per phase-03-videos/TD-07) |
| UNSUPPORTED_VIDEO_TYPE | 400 | Only video files are accepted | `contentType` at `POST /videos` does not match `video/*` (per phase-03-videos/TD-07) |
| INVALID_PART_NUMBER | 400 | Part number out of range | `POST /videos/{id}/upload/parts` with a part number > `upload_part_count` (per phase-03-videos/TD-07) |
| INVALID_UPLOAD_PARTS | 400 | Uploaded parts are invalid or incomplete | `CompleteMultipartUpload` rejected by storage (`InvalidPart`, `InvalidPartOrder`, `NoSuchUpload`) |

**Worker-side failure classification (not HTTP — recorded in `videos.processing_error`, per phase-03-videos/TD-15):**

| Class | Examples | Handling |
|-------|----------|----------|
| Permanent | ffprobe finds no video stream; ffprobe/ffmpeg rejects the input as invalid media | `throw new UnrecoverableError(...)` → job straight to failed → `processing_status = 'failed'`, `processing_error` set |
| Transient | storage/network errors, ffmpeg timeout, DB errors | Plain `Error` → BullMQ retries with exponential backoff; after the last attempt → `processing_status = 'failed'`, `processing_error` set |

---

### Events/Messages

#### video-processing / `process`

**Queue:** `video-processing` (BullMQ on Redis `redis` service, `maxmemory-policy noeviction` + AOF — per phase-03-videos/TD-01)

**Payload:**

```json
{ "videoId": "uuid" }
```

The DB row is the source of truth; the payload carries only `videoId` (per phase-03-videos/TD-01).

**Job options:** `jobId: videoId` (deduplication — per phase-03-videos/TD-08), `attempts` and `backoff: { type: 'exponential', delay }` from env (per phase-03-videos/TD-15). Completed/failed job retention must keep the `jobId` long enough for deduplication; the processor's idempotency is the real guard (per phase-03-videos/TD-15).

**Producer:** `VideosService` (API process), on `POST /videos/{id}/upload/complete`, **after** the `processing` status is committed (per phase-03-videos/TD-08)
**Consumer:** `VideoProcessor extends WorkerHost` registered only in `WorkerModule`, booted by `src/worker.ts` via `NestFactory.createApplicationContext` in the `video-worker` Compose service (per phase-03-videos/TD-02). Never registered in `AppModule`.
**Trigger:** successful upload completion
**Delivery semantics:** at-least-once (per phase-03-videos/TD-15) — processor is idempotent: skips if `processing_status = 'ready'`; the thumbnail key `{videoId}.jpg` is deterministic, so a re-run overwrites

**Processing steps (per phase-03-videos/TD-09, TD-10):**
1. Load the video; skip if `ready`.
2. Presign a short-lived internal `GET` (internal client, `http://minio:9000`) for `videos/{videoId}/original` and pass it as ffprobe/ffmpeg `-i` input — no full download.
3. `ffprobe -v error -print_format json -show_format -show_streams <url>` via `execFile` → persist `duration`, `width`, `height`, `video_codec`, `audio_codec` (nullable), `size_bytes`, `mime`. No video stream → `UnrecoverableError`.
4. `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2 <out>.jpg` with `t` ≈ 10% of `duration`, clamped to the video length → upload to `thumbnails/{videoId}.jpg` → set `thumbnail_key`.
5. Set `processing_status = 'ready'`.

**Final failure hook:** `@OnWorkerEvent('failed')` — when the error is `UnrecoverableError` or `attemptsMade ≥ attempts`, set `processing_status = 'failed'` and record `processing_error` (per phase-03-videos/TD-15).

---

## Dependency Map

```
SI-03.1 (root — infra: deps, redis, minio)
└── SI-03.2 — depends on SI-03.1 (env keys and Compose services)
    ├── SI-03.3 — depends on SI-03.2 (storageConfig)
    │   └── SI-03.10 — depends on SI-03.2 + SI-03.3 (videoProcessingConfig; internal presigned URL for integration tests)
    └── SI-03.8 — depends on SI-03.2 + SI-03.5 (queueConfig; VideosModule registers the queue)

SI-03.4 (root — Video entity + migration)

SI-03.3 + SI-03.4
└── SI-03.5 — POST /videos
    ├── SI-03.8 — queue registration in VideosModule
    └── SI-03.6 — POST /videos/{id}/upload/parts
        └── SI-03.7 — GET /videos/{id}/upload/parts

SI-03.7 + SI-03.8
└── SI-03.9 — POST /videos/{id}/upload/complete

SI-03.8 + SI-03.10
└── SI-03.11 — worker entrypoint + video-worker service

SI-03.9 + SI-03.11
└── SI-03.12 — VideoProcessor
    └── SI-03.13 — GET /videos/{slug}/stream
        └── SI-03.14 — GET /videos/{slug}/download
            └── SI-03.15 — regenerate committed OpenAPI spec
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6, SI-03.8, SI-03.10 (parallel) → SI-03.7 → SI-03.9, SI-03.11 (parallel) → SI-03.12 → SI-03.13 → SI-03.14 → SI-03.15

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, Redis e MinIO no Compose
- [ ] SI-03.2 — Infra: namespaces de configuração de fila, storage, upload e processamento
- [ ] SI-03.3 — StorageModule com clientes S3 interno e público
- [ ] SI-03.4 — Entidade Video e migration
- [ ] SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)
- [ ] SI-03.6 — Endpoint POST /videos/{id}/upload/parts (URLs pré-assinadas de parts)
- [ ] SI-03.7 — Endpoint GET /videos/{id}/upload/parts (retomada do upload)
- [ ] SI-03.8 — Infra: fila `video-processing` (BullModule)
- [ ] SI-03.9 — Endpoint POST /videos/{id}/upload/complete (conclusão + disparo do processamento)
- [ ] SI-03.10 — FfmpegService (ffprobe + extração de thumbnail)
- [ ] SI-03.11 — Infra: entrypoint do worker e serviço `video-worker`
- [ ] SI-03.12 — VideoProcessor (processamento, idempotência e falha final)
- [ ] SI-03.13 — Endpoint GET /videos/{slug}/stream (streaming via redirect)
- [ ] SI-03.14 — Endpoint GET /videos/{slug}/download (download via redirect)
- [ ] SI-03.15 — Regenerar a especificação OpenAPI commitada

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
