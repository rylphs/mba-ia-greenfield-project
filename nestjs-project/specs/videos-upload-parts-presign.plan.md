---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-parts-presign.e2e-spec.ts
---

# POST /videos/{id}/upload/parts — Test Plan

## Application Overview

`POST /videos/{id}/upload/parts` entrega ao dono do vídeo, em lote, URLs pré-assinadas de `UploadPart` (assinadas com o cliente S3 público) para que os bytes sigam direto ao storage sem passar pela API. A resposta `200` traz `{ parts: [{ partNumber, url }], expiresIn }` na ordem pedida, com `expiresIn = UPLOAD_URL_EXPIRES_SECONDS`. Não-donos recebem `404 VIDEO_NOT_FOUND` (existência não é revelada); vídeo fora de `awaiting_upload` → `409 INVALID_VIDEO_STATE`; part acima de `upload_part_count` → `400 INVALID_PART_NUMBER`; `id` não-UUID ou body inválido → `400 VALIDATION_ERROR`.

## Test Scenarios

### 1. URLs pré-assinadas de parts para o dono

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco via `cleanAllTables(dataSource)` (incluindo `videos`). Dois usuários autenticados (dono e não-dono) via helper register → confirm-email → login. Vídeo arranjado via `POST /videos` do dono com `fileSize: 104857600` (garante `partCount ≥ 2`). Requisições diretas ao storage partem do container de teste: a URL assinada tem host `S3_PUBLIC_ENDPOINT` (`localhost:9000`), inalcançável de dentro do container — enviar para `S3_ENDPOINT` (`minio:9000`) com o mesmo path + query e header `Host` igual ao host assinado, preservando a assinatura SigV4.

#### 1.1. dono-recebe-urls-na-ordem-pedida-e-put-devolve-etag

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos/{id}/upload/parts pelo dono com `{ partNumbers: [2, 1] }`
    - expect: status `200`
    - expect: `parts` tem duas entradas `{ partNumber, url }` na ordem pedida (`2`, depois `1`), cada `url` com host de `S3_PUBLIC_ENDPOINT`
    - expect: `expiresIn` = valor configurado de `UPLOAD_URL_EXPIRES_SECONDS`
  2. PUT de alguns bytes na `url` da part 1 (roteada ao MinIO conforme Setup)
    - expect: status `200` com header `ETag` não vazio

#### 1.2. nao-dono-recebe-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos/{id}/upload/parts com o token do outro usuário e `{ partNumbers: [1] }`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

#### 1.3. part-number-acima-do-part-count

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos/{id}/upload/parts pelo dono com `{ partNumbers: [partCount + 1] }` (`partCount` da resposta do `POST /videos`)
    - expect: status `400` com `error: "INVALID_PART_NUMBER"`

#### 1.4. video-fora-de-awaiting-upload

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. Arrange: atualizar a linha do vídeo para `processing_status = 'processing'` via repositório
  2. POST /videos/{id}/upload/parts pelo dono com `{ partNumbers: [1] }`
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`

#### 1.5. id-nao-uuid-ou-part-numbers-vazio

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos/not-a-uuid/upload/parts pelo dono com `{ partNumbers: [1] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  2. POST /videos/{id}/upload/parts pelo dono com `{ partNumbers: [] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
