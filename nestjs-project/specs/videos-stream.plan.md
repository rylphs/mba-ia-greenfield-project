---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: test/videos-stream.e2e-spec.ts
---

# GET /videos/{slug}/stream — Test Plan

## Application Overview

`GET /videos/{slug}/stream` é o endpoint estável de reprodução pela URL única do vídeo: a API autoriza (owner-only enquanto todo vídeo é rascunho) e responde `302` com `Location` = URL pré-assinada de `GetObject` (cliente S3 público, sem `ResponseContentDisposition`, `expiresIn = STREAM_URL_EXPIRES_SECONDS`). O storage atende `Range` → `206` nativamente; nenhum byte passa pela API. Vídeo não `ready` → `409 VIDEO_NOT_READY`; não-dono → `404 VIDEO_NOT_FOUND`; sem token → `401`; `slug` fora de `^[A-Za-z0-9_-]{11}$` → `400 VALIDATION_ERROR`.

## Test Scenarios

### 1. Streaming via redirect para URL pré-assinada

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco via `cleanAllTables(dataSource)` (incluindo `videos`) e a fila `video-processing` (`obliterate({ force: true })`). Dois usuários autenticados (dono e não-dono) via helper register → confirm-email → login. Vídeo `ready` arranjado pelo fluxo real de upload do dono (`POST /videos` com `fileSize` ≤ `partSize` → presign → `PUT` de 2048 bytes → `complete`) seguido de `processing_status = 'ready'` via repositório (sem worker). Requisições diretas ao storage partem do container de teste: URLs assinadas têm host `S3_PUBLIC_ENDPOINT` (`localhost:9000`), inalcançável de dentro do container — enviar para `S3_ENDPOINT` (`minio:9000`) com o mesmo path + query e header `Host` igual ao host assinado. Não seguir redirects no supertest (`.redirects(0)`).

#### 1.1. dono-de-video-ready-recebe-302-para-storage-publico

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. GET /videos/{slug}/stream pelo dono
    - expect: status `302`
    - expect: header `Location` começa com `S3_PUBLIC_ENDPOINT`, aponta para `videos/{videoId}/original` e não contém `response-content-disposition`

#### 1.2. location-atende-range-com-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. GET /videos/{slug}/stream pelo dono e capturar o `Location`
  2. GET no `Location` (roteado ao MinIO conforme Setup) com header `Range: bytes=0-1023`
    - expect: status `206`
    - expect: header `Content-Range` = `bytes 0-1023/2048`
    - expect: corpo com exatamente 1024 bytes

#### 1.3. video-em-processing-recebe-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. Arrange: atualizar a linha do vídeo para `processing_status = 'processing'` via repositório
  2. GET /videos/{slug}/stream pelo dono
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

#### 1.4. nao-dono-recebe-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. GET /videos/{slug}/stream com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

#### 1.5. sem-access-token-recebe-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. GET /videos/{slug}/stream sem header `Authorization`
    - expect: status `401`
    - expect: nenhum header `Location`

#### 1.6. slug-com-formato-invalido-recebe-400

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. GET /videos/abcde/stream pelo dono (slug de 5 chars)
    - expect: status `400` com `error: "VALIDATION_ERROR"`
