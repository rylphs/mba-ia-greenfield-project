---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-parts-list.e2e-spec.ts
---

# GET /videos/{id}/upload/parts — Test Plan

## Application Overview

`GET /videos/{id}/upload/parts` permite ao cliente retomar um upload interrompido: consulta no storage (`ListParts`) quais parts já chegaram e devolve `{ parts: [{ partNumber, etag, size }], partSize, partCount }`, ordenado por `partNumber` e com array vazio quando nada foi enviado. Reutiliza as regras de posse e estado dos endpoints de upload: não-dono → `404 VIDEO_NOT_FOUND`; vídeo fora de `awaiting_upload` → `409 INVALID_VIDEO_STATE`.

## Test Scenarios

### 1. Retomada do upload pelo dono

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco via `cleanAllTables(dataSource)` (incluindo `videos`). Dois usuários autenticados (dono e não-dono) via helper register → confirm-email → login. Vídeo arranjado via `POST /videos` do dono com `fileSize` que gere `partCount ≥ 3`. Parts enviadas obtendo URLs em `POST /videos/{id}/upload/parts` e fazendo `PUT` direto no storage — a URL assinada tem host `S3_PUBLIC_ENDPOINT` (`localhost:9000`), inalcançável de dentro do container: enviar para `S3_ENDPOINT` (`minio:9000`) com o mesmo path + query e header `Host` igual ao host assinado.

#### 1.1. lista-vazia-antes-de-qualquer-part

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. GET /videos/{id}/upload/parts pelo dono, sem nenhum `PUT` prévio
    - expect: status `200`
    - expect: `parts` é `[]`; `partSize` e `partCount` iguais aos retornados pelo `POST /videos`

#### 1.2. lista-apenas-as-parts-enviadas

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. Arrange: presign das parts 1 e 3 e `PUT` de bytes em cada URL, guardando os `ETag`s e tamanhos enviados
  2. GET /videos/{id}/upload/parts pelo dono
    - expect: status `200`
    - expect: `parts` contém exatamente `partNumber` 1 e 3, nessa ordem
    - expect: cada entrada tem `etag` igual ao `ETag` do respectivo `PUT` e `size` igual ao número de bytes enviados

#### 1.3. nao-dono-recebe-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. GET /videos/{id}/upload/parts com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

#### 1.4. video-ready-recebe-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. Arrange: atualizar a linha do vídeo para `processing_status = 'ready'` via repositório
  2. GET /videos/{id}/upload/parts pelo dono
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`
