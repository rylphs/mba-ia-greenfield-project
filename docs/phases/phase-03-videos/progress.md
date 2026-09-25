# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 8/15 completed

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
- **Status:** completed
- **Tests:** 23 passing
- **Observations:**
  - `ChannelsService.findByUserId` usa `dataSource.getRepository(Channel).findOne(...)` em vez de injetar `Repository<Channel>` no construtor — mantém o padrão existente do serviço (só `DataSource` é injetado; `createChannel` já usa `dataSource.transaction`).
  - `VideosService.createUpload` injeta `Repository<Video>` mas roda a criação do rascunho + `StorageService.createMultipartUpload` + gravação do `upload_id` dentro de uma única `videoRepo.manager.transaction(...)`, com `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` por tentativa de slug (per `.claude/rules/typeorm-queries.md` — sem savepoint, uma violação de unique aborta a transação Postgres inteira e impede o retry). Isso garante o rollback do insert quando o storage falha (AC coberto por `videos.service.integration-spec.ts`) e ainda permite mock de `manager` em unit test (`videos.service.spec.ts`) via `videoRepo.manager.transaction = jest.fn((cb) => cb(mockManager))`, per `.claude/rules/nestjs-testing.md`.
  - `MAX_SLUG_ATTEMPTS = 3` interpretado como 3 tentativas totais (não 3 retries após a primeira) — a redação do plano ("regenerando o slug em violação unique até 3 tentativas") é ambígua nesse ponto; optei pela leitura mais literal.
  - Nenhum código de erro de domínio existe para "usuário autenticado sem canal" (não está no Error Catalog da fase — todo usuário registrado ganha canal via `UsersService.createUserWithChannel`, então é tratado como invariante e propaga um `Error` genérico em vez de uma `DomainException`, seguindo a regra de nunca engolir erros).
  - Endpoint usa schema inline (`schema: { properties: {...} }`) no `@ApiResponse` 201 em vez de `type: CreateVideoUploadResponseDto`, para bater com o padrão observado em todo o `auth.controller.ts` (nenhum endpoint existente usa `type:`/`@ApiBody` — Swagger infere o body do parâmetro `@Body() dto`).
  - `/simplify`: extraí `isPgUniqueViolationOnColumn`/`PG_UNIQUE_VIOLATION` (copiado verbatim de `channels.service.ts`) para `src/common/typeorm/pg-errors.ts`, reusado por `ChannelsService` e `VideosService`; troquei o `manager.save(video)` final (só para gravar `upload_id`) por `manager.update(Video, video.id, { upload_id })` — evita round-trip do entity inteiro por uma única coluna; simplifiquei o savepoint de nome único por tentativa (`slug_attempt_${attempt}`) para um nome fixo reusado (`SLUG_SAVEPOINT`), já que as tentativas são sequenciais, não aninhadas. A extração do helper `pg-errors.ts` moveu 6 erros de lint pré-existentes (`no-unsafe-*` sobre `err as any`) do arquivo antigo para o novo; corrigi tipando via uma interface `PgQueryFailedError extends QueryFailedError` local em vez de `any`. Não apliquei a sugestão de unificar os dois mecanismos de retry (savepoint-por-tentativa em `VideosService` vs. nova transação por tentativa em `ChannelsService`) nem a de trocar o `Error` genérico de "usuário sem canal" por uma nova categoria de `DomainException` — ambas tocariam código já testado fora do escopo desta SI. Ajustei `videos.service.spec.ts` (mock `manager` sem `update` quebrava 3 testes após a troca save→update) e a asserção de contagem de `manager.save` (2 em vez de 3, já que o save final virou update).

### SI-03.6 — Endpoint POST /videos/{id}/upload/parts (URLs pré-assinadas de parts)
- **Status:** completed
- **Tests:** 18 passing
- **Observations:**
  - `presignParts` roda as N chamadas a `StorageService.presignUploadPart` em paralelo via `Promise.all(partNumbers.map(...))` — a ordem do array de resultado é a ordem de `partNumbers` independente da ordem de resolução das promises, então o AC "ordem pedida" é preservado sem precisar de índice manual.
  - E2E reusa o helper `requestViaInternalNetwork` (criado no `/simplify` da SI-03.3) para o `PUT` real contra o MinIO, já que a URL pré-assinada aponta para `S3_PUBLIC_ENDPOINT` (`localhost:9000`), inalcançável de dentro do container de teste.
  - `/simplify`: `findOwnedById` trocou duas queries sequenciais (`ChannelsService.findByUserId` + `videoRepo.findOne`) por um único `createQueryBuilder('video').innerJoin('video.channel', 'channel', 'channel.user_id = :userId', ...)` — 1 round-trip a menos por chamada, usando a relação `video.channel` já existente (SI-03.4) em vez de nomes de tabela crus; dono errado e canal inexistente continuam colapsando no mesmo `VIDEO_NOT_FOUND`. `assertAwaitingUpload` virou uma assertion function TS (`asserts video is Video & { upload_id: string }`) que também absorve o check de `upload_id` nulo (antes um segundo `if` solto em `presignParts`) — mesma invariante estrutural documentada (nunca deveria disparar, já que `createUpload` sempre grava `upload_id` antes de deixar o vídeo em `awaiting_upload`), agora com o tipo narrado no compilador em vez de um cast manual downstream. `@HttpCode(200)` virou `@HttpCode(HttpStatus.OK)` para bater com o resto do controller layer (`auth.controller.ts`). Reescrevi o describe `presignParts` de `videos.service.spec.ts` para mockar `videoRepo.createQueryBuilder()` (chain `innerJoin`/`where`/`getOne`) em vez de `channelsService.findByUserId` + `videoRepo.findOne` separados — os dois testes de "sem canal"/"dono errado" colapsaram em um só ("nenhum vídeo owned encontrado"), por isso o total caiu de 19 para 18. Não apliquei a sugestão de Altitude de rotear a invariante de `upload_id` nulo por uma `DomainException` (via `DomainExceptionFilter`) em vez de `Error` genérico — contradiz o precedente já deliberado na SI-03.5 para invariantes fora do Error Catalog (um bug real nesse ponto deve mesmo virar 500 não-tratado, não um envelope de erro de domínio). Não extraí as `const key`/`uploadId`/`expiresIn` de `presignParts` (sugestão de Simplification) além do necessário: `uploadId` precisa continuar como `const` local para a closure do `.map()` enxergar o tipo já estreitado pela assertion function — TS não propaga narrowing de member access para dentro de closures.

### SI-03.7 — Endpoint GET /videos/{id}/upload/parts (retomada do upload)
- **Status:** completed
- **Tests:** 8 passing
- **Observations:**
  - `listUploadedParts` reusa `findOwnedById`/`assertAwaitingUpload` (SI-03.6) sem duplicar as regras de posse/estado; delega a listagem real ao `StorageService.listParts` (já existente desde SI-03.3) e só ordena/mapeia o resultado por `partNumber`.
  - Fixture do e2e (`test/videos-upload-parts-list.e2e-spec.ts`) precisou de `fileSize = 200MiB` no cenário "lista-apenas-as-parts-enviadas" para garantir `partCount ≥ 3` (o default de 100MiB do helper `createVideo` só gera 2 parts com o `partSizeBytes` atual) — sem isso o presign da part 3 falhava com `400 INVALID_PART_NUMBER` antes mesmo de chegar no GET sob teste.
  - `/simplify`: paralelizei os dois loops de `PUT` sequenciais (um em `videos.service.integration-spec.ts`, outro no e2e) com `Promise.all`, já que cada `PUT` é I/O independente contra keys/URLs diferentes no MinIO — reduz o tempo de wall-clock do teste sem mudar as asserções. Não apliquei a sugestão de Altitude de mover as non-null assertions (`part.PartNumber!`/`ETag!`/`Size!`) do `Video.Service.listUploadedParts` para dentro de `StorageService.listParts` (normalizando o retorno do SDK lá): isso mudaria a assinatura de um método pré-existente (SI-03.3) que já tem outro consumidor fora do escopo desta SI (`storage.service.integration-spec.ts`), contradizendo a diretriz de não tocar código fora do diff revisado. As demais sugestões (Reuse e Simplification) não encontraram nada acionável — código já reusa `findOwnedById`/`assertAwaitingUpload`/`StorageService.listParts` como esperado.

### SI-03.8 — Infra: fila `video-processing` (BullModule)
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - `ioredis` não estava no `package.json` apesar de ser peer dependency obrigatória do backend Redis padrão do `bullmq` 6.x (`bullmq-otel`/`redis` também são peers opcionais, mas `ioredis` é quem o `BullModule.forRootAsync` usa por trás dos panos ao passar `connection: { host, port }`). Sem ele, `QueueModule.spec.ts` falhava na compilação do módulo com `BullMQ could not load the optional 'ioredis' package`. Instalado via `docker compose exec nestjs-api npm install ioredis@^5.4.1` (resolveu para `^5.11.1`); não estava listado nas Technical actions da SI-03.1 nem da SI-03.8, mas é uma dependência estrutural do próprio `@nestjs/bullmq`/`bullmq` já instalados, não uma decisão de escopo.

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
