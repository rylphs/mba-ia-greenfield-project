# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/15 completed

### SI-03.1 — Infra: dependências, Redis e MinIO no Compose
- **Status:** completed
- **Tests:** no tests (Infra) — os 5 ACs foram verificados manualmente no Compose
- **Observations:**
  - **Desvio da TD-03 (decidido pelo usuário em 2026-09-24):** `quay.io/minio/minio` e `quay.io/minio/mc` devolvem `unauthorized` no pull, e `minio/minio` não existe mais no Docker Hub. Troquei por `cgr.dev/chainguard/minio:latest-dev` e `cgr.dev/chainguard/minio-client:latest-dev`, pinados por digest (Option B da TD-03). A variante `-dev` tem `wget`/`sh` para o healthcheck e o script de init. Versão do servidor: `RELEASE.2026-09-22T19-25-18Z`. Falta registrar como Revision na TD-03 via `/decide`: editar o decisions doc direto deixaria o plano stale no `sources_mtime`.
  - **CORS (confirmado via context7):** o MinIO community não implementa a API BucketCORS. As origens permitidas são server-wide via `MINIO_API_CORS_ALLOW_ORIGIN` (fixei `http://localhost:3001`, a origem do `next-frontend`), no serviço `minio` e não no `minio-init`. O `ETag` já faz parte dos headers expostos por padrão.
  - **AC #4, texto vs. comportamento:** a preflight `OPTIONS` devolve `204` com `Allow-Origin`/`Allow-Methods`, mas sem `Access-Control-Expose-Headers`, como manda o padrão CORS. O header (com `Etag`) vem na resposta real. A intenção do AC (o browser lê o `ETag` do `PUT`) está atendida.
  - Usei `redis:7.4-alpine`, já que o plano não fixa versão do Redis. Sem chave de env para a origem CORS, porque a lista de chaves do plano não inclui uma.

### SI-03.2 — Infra: namespaces de configuração de fila, storage, upload e processamento
- **Status:** completed
- **Tests:** 12 passing
- **Observations:**
  - `FFMPEG_TIMEOUT_MS`: `Joi.number().positive().default(30000)`, igual aos irmãos `attempts`/`backoffDelayMs` do mesmo config — é um tuning knob operacional, não um segredo por ambiente, então tratá-lo como `.required()` (decisão inicial revertida no `/simplify`) só empurrava o default de volta para os arquivos `.env`/`.env.example`.
  - Backfillei `env.validation.ts` com validadores Joi para as chaves `REDIS_*`/`S3_*` que a SI-03.1 já tinha adicionado a `.env.example`/`.env` mas que ainda dependiam só de `allowUnknown: true` (nenhuma SI anterior as validava).
  - Atualizei `.env` (não só `.env.example`) com as novas chaves de upload/processamento — necessário para a aplicação inicializar.
  - `/simplify`: troquei o parser manual de `.env.example` no teste por `dotenv.parse` (já usado internamente por `@nestjs/config` e pelo `setupFiles` do Jest) e promovi `dotenv` de dependência transitiva para `devDependency` explícita em `package.json`.

### SI-03.3 — StorageModule com clientes S3 interno e público
- **Status:** completed
- **Tests:** 7 passing
- **Observations:**
  - `S3_PUBLIC_ENDPOINT` (`localhost:9000`) não é alcançável de dentro do container `nestjs-api` (só a porta 3000 é publicada nesse namespace) — é host-facing por design, para o browser/`next-frontend`. O teste de integração contorna isso conectando via TCP ao host interno (`minio:9000`, sempre alcançável) mas preservando o header `Host` original da URL presignada; SigV4 valida o header `host` assinado, não o peer TCP, e a política anônima do MinIO não depende de host — então a assinatura/policy real é exercitada sem mudar o que está sendo testado.
  - Tokens dos providers (`S3_INTERNAL_CLIENT`/`S3_PUBLIC_CLIENT`) são strings simples, não `Symbol` — não há precedente de token `Symbol`-based no projeto (`mail.constants.ts`/`auth.constants.ts` só têm valores literais).
  - `/simplify`: extraí `buildS3Client(endpoint, cfg)` em `storage.module.ts` (as duas factories dos clientes S3 eram cópia quase idêntica); movi o helper de request cru (`requestViaInternalNetwork`) do spec de integração para `src/test/minio.ts`, espelhando o precedente `src/test/mailpit.ts` — SIs futuras de upload/E2E devem reusar esse helper em vez de duplicá-lo; extraí `uploadTestObject()` para o setup repetido (create→presign→PUT→complete) nos testes que não precisam inspecionar `listParts`/host da URL; paralelizei as duas leituras independentes (Content-Disposition e Range) do mesmo `downloadUrl` com `Promise.all`.

### SI-03.4 — Entidade Video e migration
- **Status:** completed
- **Tests:** 6 passing
- **Observations:**
  - Sem precedente de `transformer` numérico no projeto para colunas `bigint` (grep confirmou). Escrevi um transformer local em `video.entity.ts` (`to`/`from` com `Number()`) em vez de extrair para um arquivo compartilhado — só `Video` precisa disso hoje.
  - `migration:generate` prefixa o próprio timestamp ao nome passado; passar um caminho já com timestamp gera nome/classe duplo-prefixados. Renomeei o arquivo e a classe para o padrão de timestamp único das migrations existentes (`CreateVideos1790357447592`).
  - Corrigi um gap de idempotência pré-existente em `migrations.integration-spec.ts`: `DROP TABLE ... CASCADE` no `beforeAll` não remove os enum types das colunas — um `verification_tokens_type_enum` de uma execução anterior colidia com o `CREATE TYPE` da migration `CreateAuthTokens` na re-execução. Adicionei `DROP TYPE IF EXISTS` explícito (`MANAGED_ENUM_TYPES`) para os três enums geridos (o pré-existente + os dois novos de `Video`). Também ajustei o teste de revert: com `CreateVideos` agora sendo a última migration, `undoLastMigration()` remove a tabela `videos`, não mais as tabelas de token.
  - Atualizei os 7 integration-specs existentes que já montavam `ALL_ENTITIES` com `Channel` para incluir `Video` — necessário porque `Channel` ganhou `@OneToMany(() => Video, ...)` e o TypeORM exige a entidade relacionada registrada no mesmo `DataSource`.
  - `/simplify`: renomeei `requiredFields()` para `buildVideo(channelId, overrides)`, espelhando o padrão `buildToken(id, overrides)` já usado em `refresh-token`/`verification-token` specs; juntei os dois testes com arrange idêntico (defaults + campos nulos) em um só; removi um `counter` sem uso real em `createChannel()` (cada teste chama no máximo uma vez, e `beforeEach` já limpa as tabelas). A revisão de Altitude achou um bug real introduzido por esta SI: `Channel` ganhou `@OneToMany(() => Video, ...)`, o que quebra silenciosamente 3 `*.module.spec.ts` (`channels`, `auth`, `users`) que montam `DataSource`/`TypeOrmModule` com `Channel` mas sem `Video` — nenhum estava na minha varredura inicial (só busquei por `*.entity.integration-spec.ts`/`*.service.integration-spec.ts`). Corrigi os 3. Tentei paralelizar os `DROP TABLE`/`DROP TYPE` do `beforeAll` de `migrations.integration-spec.ts` e os `DELETE` de `cleanAllTables` via `Promise.all` (sugestão de Efficiency) — causou deadlock real do Postgres (`DataSource.query` concorrente não é seguro aqui); revertido para sequencial após reproduzir a falha e confirmar a correção com 3 execuções seguidas sem deadlock. Não apliquei a sugestão de Altitude de extrair um `ALL_ENTITIES` compartilhado em `create-test-data-source.ts` (tocaria ~12 arquivos, incluindo vários fora desta SI) nem a limpeza de enums via `pg_type` — mudanças de escopo maior que ficam para uma tarefa dedicada.
  - Lint: 194 problemas pré-existentes no repo (confirmados por 3 subagents em rodadas diferentes), nenhum nos arquivos novos (`video.entity.ts`, `video.entity.integration-spec.ts`, migration, `channel.entity.ts`). Dois hits caem em arquivos tocados por esta SI mas em linhas não tocadas (`create-test-data-source.ts:9` — `Function` type pré-existente; `users.service.integration-spec.ts:12` — import não usado pré-existente).

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
