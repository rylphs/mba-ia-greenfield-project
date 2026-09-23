---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-23T17:06:01-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-23T08:13:16-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Pré-cadastro como rascunho: campos iniciais e fronteira com o fluxo da Fase 04"
    resolved_by: phase-03-videos/TD-14
  - id: AMB-2
    status: resolved
    summary: "Saídas do processamento: quais metadados extrair e qual frame/formato da thumbnail"
    resolved_by: phase-03-videos/TD-09
  - id: AMB-3
    status: resolved
    summary: "Subprojetos afetados não nomeados: UI de upload/player na fase 03 ou adiada?"
    resolved_by: deferred_capability
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Queue Technology (Message Queue)"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Video Worker Runtime Topology"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Object Storage Runtime Image (local S3-compatible service)"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Storage Layout: buckets, object keys, thumbnail exposure"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Presigned URL Host Resolution Under Docker Networking"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Upload Protocol for Files up to 10 GB"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Upload Limits Contract (part size, max size, URL expiry)"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Upload Completion Detection and Processing Trigger"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — FFmpeg Integration in the Worker"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — How the Worker Reads the Source Video"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Unique Video URL Identifier"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Access Policy for Stream/Download Before Publication Exists"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "TD-14 pending — Video Status Model"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-15
    status: resolved
    summary: "TD-15 pending — Failure, Retry and Abandoned-Upload Policy"
    resolved_by: phase-03-videos/TD-15
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI not in scope — `## UI Inventory` absent from context.md.)_

## Resolved Issues

- **AMB-1** _(resolved_by phase-03-videos/TD-14)_ — Pré-cadastro como rascunho: campos iniciais e fronteira com a Fase 04. Clarificado: dono = canal do usuário; `title` default = nome do arquivo sem extensão; `description` nula; `publication_status = draft`; nenhuma edição de metadados na Fase 03. Registrado como Revision 2026-09-23 em TD-14.
- **AMB-2** _(resolved_by phase-03-videos/TD-09)_ — Saídas do processamento. Clarificado: `duration`, `width`, `height`, `video_codec`, `audio_codec` (nullable), `size_bytes`, `mime`/container; thumbnail JPEG em ~10% da duração, largura 1280 mantendo proporção. Registrado como Revision 2026-09-23 em TD-09.
- **AMB-3** _(resolved_by deferred_capability)_ — Fatia backend-only; superfícies de UI (upload, streaming, download) registradas como `deferred` em `## Non-UI / Deferred Capabilities` do context.md.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 pending — Queue Technology (Message Queue). Decision: A (BullMQ + Redis via @nestjs/bullmq 11.x).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 pending — Video Worker Runtime Topology. Decision: A (mesmo codebase, 2º entrypoint, serviço Compose).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 pending — Object Storage Runtime Image (local S3-compatible service). Decision: A (MinIO quay.io pinado).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 pending — Storage Layout: buckets, object keys, thumbnail exposure. Decision: B (bucket privado `videos` + público `thumbnails`).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 pending — Presigned URL Host Resolution Under Docker Networking. Decision: A (dois clientes S3: interno + público).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 pending — Upload Protocol for Files up to 10 GB. Decision: A (S3 multipart com part URLs pré-assinadas).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 pending — Upload Limits Contract (part size, max size, URL expiry). Decision: A (part size fixo ditado pelo servidor).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 pending — Upload Completion Detection and Processing Trigger. Decision: A (endpoint explícito de conclusão).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 pending — FFmpeg Integration in the Worker. Decision: A (FFmpeg do sistema + execFile).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 pending — How the Worker Reads the Source Video. Decision: A (FFmpeg lê URL pré-assinada interna).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 pending — Unique Video URL Identifier. Decision: B (slug aleatório 11 chars base64url + unique index).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 pending — Streaming and Download Delivery. Decision: A (302 para GET pré-assinado + attachment).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 pending — Access Policy for Stream/Download Before Publication Exists. Decision: A (somente o dono enquanto rascunho).
- **OQ-14** _(resolved_by phase-03-videos/TD-14)_ — TD-14 pending — Video Status Model. Decision: B (processing_status + publication_status).
- **OQ-15** _(resolved_by phase-03-videos/TD-15)_ — TD-15 pending — Failure, Retry and Abandoned-Upload Policy. Decision: A (retries limitados + UnrecoverableError + expiração de multipart).
