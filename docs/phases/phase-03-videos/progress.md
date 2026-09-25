# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/15 completed

### SI-03.1 — Infra: dependências, Redis e MinIO no Compose
- **Status:** completed
- **Tests:** no tests (Infra) — os 5 ACs foram verificados manualmente no Compose
- **Observations:**
  - **Desvio da TD-03 (decidido pelo usuário em 2026-09-24):** `quay.io/minio/minio` e `quay.io/minio/mc` devolvem `unauthorized` no pull, e `minio/minio` não existe mais no Docker Hub. Troquei por `cgr.dev/chainguard/minio:latest-dev` e `cgr.dev/chainguard/minio-client:latest-dev`, pinados por digest (Option B da TD-03). A variante `-dev` tem `wget`/`sh` para o healthcheck e o script de init. Versão do servidor: `RELEASE.2026-09-22T19-25-18Z`. Falta registrar como Revision na TD-03 via `/decide`: editar o decisions doc direto deixaria o plano stale no `sources_mtime`.
  - **CORS (confirmado via context7):** o MinIO community não implementa a API BucketCORS. As origens permitidas são server-wide via `MINIO_API_CORS_ALLOW_ORIGIN` (fixei `http://localhost:3001`, a origem do `next-frontend`), no serviço `minio` e não no `minio-init`. O `ETag` já faz parte dos headers expostos por padrão.
  - **AC #4, texto vs. comportamento:** a preflight `OPTIONS` devolve `204` com `Allow-Origin`/`Allow-Methods`, mas sem `Access-Control-Expose-Headers`, como manda o padrão CORS. O header (com `Etag`) vem na resposta real. A intenção do AC (o browser lê o `ETag` do `PUT`) está atendida.
  - Usei `redis:7.4-alpine`, já que o plano não fixa versão do Redis. Sem chave de env para a origem CORS, porque a lista de chaves do plano não inclui uma.

### SI-03.2 — Infra: namespaces de configuração de fila, storage, upload e processamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — StorageModule com clientes S3 interno e público
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Entidade Video e migration
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoint POST /videos/{id}/upload/parts (URLs pré-assinadas de parts)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoint GET /videos/{id}/upload/parts (retomada do upload)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Infra: fila `video-processing` (BullModule)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Endpoint POST /videos/{id}/upload/complete (conclusão + disparo do processamento)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — FfmpegService (ffprobe + extração de thumbnail)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Infra: entrypoint do worker e serviço `video-worker`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — VideoProcessor (processamento, idempotência e falha final)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Endpoint GET /videos/{slug}/stream (streaming via redirect)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Endpoint GET /videos/{slug}/download (download via redirect)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Regenerar a especificação OpenAPI commitada
- **Status:** pending
- **Tests:** —
- **Observations:** none
