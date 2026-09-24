---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/{id}/upload/complete — Test Plan

## Application Overview

`POST /videos/{id}/upload/complete` conclui o multipart upload e dispara o processamento. A ordem é obrigatória: `CompleteMultipartUpload` → `HeadObject` (verificação do tamanho real) → grava e commita `processing_status = 'processing'` → enfileira `{ videoId }` na fila `video-processing` com `jobId = videoId`. A resposta `202` devolve `{ videoId, slug, processingStatus: "processing" }`. Parts rejeitadas pelo storage → `400 INVALID_UPLOAD_PARTS` (vídeo permanece `awaiting_upload`); tamanho real acima de `MAX_VIDEO_SIZE_BYTES` → `400 VIDEO_TOO_LARGE`, objeto apagado e vídeo `failed`; segunda conclusão → `409 INVALID_VIDEO_STATE` sem novo job; não-dono → `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Conclusão do upload e disparo do processamento

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco via `cleanAllTables(dataSource)` (incluindo `videos`) e zera a fila com `app.get(getQueueToken(VIDEO_PROCESSING_QUEUE)).obliterate({ force: true })`. Nenhum `@Processor` roda no grafo do `AppModule`, então jobs enfileirados permanecem inspecionáveis. Dois usuários autenticados (dono e não-dono) via helper register → confirm-email → login. Vídeo arranjado via `POST /videos` do dono com `fileSize` ≤ `partSize` (`partCount = 1`), presign da part 1 e `PUT` dos bytes direto no storage — a URL assinada tem host `S3_PUBLIC_ENDPOINT` (`localhost:9000`), inalcançável de dentro do container: enviar para `S3_ENDPOINT` (`minio:9000`) com o mesmo path + query e header `Host` igual ao host assinado; guardar o `ETag` devolvido.

#### 1.1. conclui-upload-e-enfileira-job

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos/{id}/upload/complete pelo dono com `{ parts: [{ partNumber: 1, etag: <ETag do PUT> }] }`
    - expect: status `202` com `videoId` igual ao `id`, `slug` do vídeo e `processingStatus: "processing"`
  2. Consultar a linha em `videos` e a fila `video-processing`
    - expect: `processing_status = 'processing'`
    - expect: `queue.getJob(videoId)` existe com `name = 'process'` e `data` igual a `{ videoId }`
    - expect: o objeto `{videoId}/original` existe no bucket `videos` (`HeadObject` via `StorageService`)

#### 1.2. segunda-conclusao-recebe-409-sem-novo-job

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos/{id}/upload/complete pelo dono com as parts válidas
    - expect: status `202`
  2. Repetir a mesma chamada
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`
    - expect: a fila contém exatamente um job (id = `videoId`)

#### 1.3. etag-divergente-recebe-400-e-mantem-awaiting-upload

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos/{id}/upload/complete pelo dono com `{ parts: [{ partNumber: 1, etag: "\"00000000000000000000000000000000\"" }] }`
    - expect: status `400` com `error: "INVALID_UPLOAD_PARTS"`
    - expect: a linha do vídeo continua com `processing_status = 'awaiting_upload'`
    - expect: nenhum job enfileirado

#### 1.4. nao-dono-recebe-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos/{id}/upload/complete com o token do outro usuário e as parts válidas
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: nenhum job enfileirado e o vídeo continua `awaiting_upload`

### 2. Verificação do tamanho real na conclusão

**Setup:** app separado (`describe` próprio) compilado com `MAX_VIDEO_SIZE_BYTES` reduzido — `overrideProvider(uploadConfig.KEY)` com `maxVideoSizeBytes: 1024` (demais valores iguais à config real) — mais a mesma config global, limpeza de banco e de fila do grupo 1. Vídeo arranjado via `POST /videos` com `fileSize: 1000` (passa no check declarado, `partCount = 1`) e `PUT` de 2048 bytes na part 1 roteado ao MinIO como no grupo 1.

#### 2.1. tamanho-real-acima-do-limite-apaga-objeto-e-marca-failed

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos/{id}/upload/complete pelo dono com `{ parts: [{ partNumber: 1, etag: <ETag do PUT> }] }`
    - expect: status `400` com `error: "VIDEO_TOO_LARGE"`
    - expect: o objeto `{videoId}/original` não existe mais no bucket `videos`
    - expect: a linha do vídeo tem `processing_status = 'failed'` e `processing_error` não nulo
    - expect: nenhum job enfileirado
