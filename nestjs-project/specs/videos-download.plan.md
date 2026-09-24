---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: test/videos-download.e2e-spec.ts
---

# GET /videos/{slug}/download — Test Plan

## Application Overview

`GET /videos/{slug}/download` usa o mesmo mecanismo do streaming (autorização owner-only + `302` para URL pré-assinada de `GetObject`), acrescentando `ResponseContentDisposition: attachment; filename="<original_filename>"` para que o navegador baixe o arquivo com o nome original. O nome é sanitizado (aspas, barras invertidas e caracteres de controle removidos) para que o header seja sempre bem formado. Vídeo não `ready` → `409 VIDEO_NOT_READY`; não-dono → `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Download via redirect com disposition de anexo

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco via `cleanAllTables(dataSource)` (incluindo `videos`) e a fila `video-processing` (`obliterate({ force: true })`). Dois usuários autenticados (dono e não-dono) via helper register → confirm-email → login. Vídeo `ready` arranjado pelo fluxo real de upload do dono (`POST /videos` com o `fileName` do cenário e `fileSize` ≤ `partSize` → presign → `PUT` dos bytes → `complete`) seguido de `processing_status = 'ready'` via repositório (sem worker). Requisições diretas ao storage partem do container de teste: URLs assinadas têm host `S3_PUBLIC_ENDPOINT` (`localhost:9000`), inalcançável de dentro do container — enviar para `S3_ENDPOINT` (`minio:9000`) com o mesmo path + query e header `Host` igual ao host assinado. Não seguir redirects no supertest (`.redirects(0)`).

#### 1.1. download-devolve-arquivo-completo-como-anexo

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. Arrange: vídeo `ready` com `fileName: "ferias.mp4"` e 2048 bytes enviados
  2. GET /videos/{slug}/download pelo dono
    - expect: status `302` com header `Location` apontando para `S3_PUBLIC_ENDPOINT`
  3. GET no `Location` (roteado ao MinIO conforme Setup)
    - expect: status `200`
    - expect: header `Content-Disposition` = `attachment; filename="ferias.mp4"`
    - expect: corpo com os 2048 bytes enviados, byte a byte

#### 1.2. nome-com-aspas-gera-disposition-bem-formada

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. Arrange: vídeo `ready` com `fileName: "fe\"rias.mp4"` (contém `"`)
  2. GET /videos/{slug}/download pelo dono e GET no `Location`
    - expect: status `200`
    - expect: header `Content-Disposition` = `attachment; filename="ferias.mp4"` — sem a aspa no nome

#### 1.3. video-em-processing-recebe-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. Arrange: atualizar a linha do vídeo para `processing_status = 'processing'` via repositório
  2. GET /videos/{slug}/download pelo dono
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

#### 1.4. nao-dono-recebe-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. GET /videos/{slug}/download com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
