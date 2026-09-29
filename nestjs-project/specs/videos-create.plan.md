---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo: pré-cadastra o rascunho no canal do usuário autenticado (`publication_status = 'draft'`, `processing_status = 'awaiting_upload'`, `title` = `fileName` sem extensão), gera o `slug` público de 11 chars base64url e abre o multipart upload no bucket `videos` (key `{videoId}/original`). A resposta `201` devolve o contrato de chunking ditado pelo servidor (`videoId`, `slug`, `uploadId`, `partSize`, `partCount`). Tamanho declarado acima de `MAX_VIDEO_SIZE_BYTES` e `contentType` fora de `video/*` são rejeitados no service; schema inválido cai no `ValidationPipe`; o endpoint é protegido pelo `JwtAuthGuard` global.

## Test Scenarios

### 1. Pré-cadastro do rascunho e início do multipart

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a config global de `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco via `cleanAllTables(dataSource)` (estendido para apagar `videos` antes de `channels`). Usuário autenticado obtido pelo helper register → confirm-email → login (padrão de `test/auth.e2e-spec.ts`), com canal próprio.

#### 1.1. cria-rascunho-e-retorna-contrato-de-upload

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ fileName: "ferias.mp4", fileSize: 104857600, contentType: "video/mp4" }`
    - expect: status `201`
    - expect: body contém `videoId` (uuid), `slug` casando `^[A-Za-z0-9_-]{11}$`, `uploadId` string não vazia, `partSize` inteiro > 0 e `partCount` = `ceil(104857600 / partSize)`
  2. Consultar a linha em `videos` pelo `videoId` retornado
    - expect: `title = "ferias"`, `description = null`, `publication_status = 'draft'`, `processing_status = 'awaiting_upload'`
    - expect: `channel_id` igual ao canal do usuário autenticado; `upload_id` igual ao `uploadId` da resposta

#### 1.2. rejeita-tamanho-declarado-acima-do-limite

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos autenticado com `{ fileName: "grande.mp4", fileSize: 10737418241, contentType: "video/mp4" }`
    - expect: status `400` com `error: "VIDEO_TOO_LARGE"` no envelope `{ statusCode, error, message }`
    - expect: nenhuma linha criada em `videos`

#### 1.3. rejeita-content-type-que-nao-e-video

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos autenticado com `{ fileName: "foto.png", fileSize: 1024, contentType: "image/png" }`
    - expect: status `400` com `error: "UNSUPPORTED_VIDEO_TYPE"`
    - expect: nenhuma linha criada em `videos`

#### 1.4. rejeita-body-sem-file-name

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos autenticado com `{ fileSize: 1024, contentType: "video/mp4" }` (sem `fileName`)
    - expect: status `400` com `error: "VALIDATION_ERROR"` (prova que o `ValidationPipe` está ativo no endpoint)

#### 1.5. exige-access-token

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido
    - expect: status `401`
    - expect: nenhuma linha criada em `videos`

#### 1.6. gera-slugs-distintos-entre-uploads

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-24T21:03:59Z

**Steps:**
  1. POST /videos autenticado duas vezes seguidas com body válido
    - expect: ambas as respostas `201`
    - expect: os dois `slug`s retornados são diferentes entre si
