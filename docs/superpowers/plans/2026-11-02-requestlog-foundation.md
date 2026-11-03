# Phase 1 — RequestLog Foundation (revision 2)

Repo `D:\AI-Application\LLM Gateway` · branch `main` @ `56112fc` · 2026-11-02
Status: **plan only** — no source edits, no migrations run, no seed, no commits.

Revision 2 changes, in one line each: migration is applied **after all application code exists** (Task 11), not after Task 6; `RequestContext` exposes `userId` and nothing else (the `context.user.id` example is gone); `AttemptRecordInput` carries `overheadMs` from one derivation helper; §4.3 is a real migration-verification checklist instead of "look at it"; error classification is verified against the **full response envelope**, including `param`; plus six cross-contract defects found while re-reading (Task 9/10 split, controller signature, optional logger call, `wireCode` vs `errorCode`, `retryAfterMs`, app-against-unmigrated-DB).

## 1. Context & goal

"Observable software" here means: for every authenticated `POST /api/v1/chat/completions`, an operator answers five questions from the database alone, without reproducing the request.

1. Which model was requested, which model actually served it, through which provider?
2. How many upstream attempts ran, in what order, and why did each fail?
3. How long did each attempt take, split into provider time and gateway overhead?
4. What did the call cost, and which price row produced that number?
5. If it failed, which *class* of failure was it — caller, provider, config, or us?

Today none of that is answerable for failures, and only partly for successes. Phase 1 makes failures observable, prices successes, and installs a `RequestContext` so BYOK, insights, governance and streaming do not reshape the write path later.

**Hard scope constraint:** Phase 1 changes **no existing HTTP response shape**. The "responses stay byte-identical" rule covers **every existing endpoint** — `POST /api/v1/chat/completions`, `/insights/me`, `/admin/insights`, `/spend/*`, `/models`. `InsightsService` is not touched at all. Analytics that surface `status`, `failureClass` or cost land in **Phase 4**.

## 2. Current state & dependency map

### 2.1 Verified current state

| Fact | Evidence |
|---|---|
| Only the success path is logged, by one `prisma.requestLog.create()` | `src/modules/gateway/gateway.service.ts:95-128` |
| `cost` is always written `null` | `gateway.service.ts:114` |
| `latencyMs` is provider-reported, not end-to-end | `gateway.service.ts:110` |
| `RequestContext` is a private 3-field interface inside the service | `gateway.service.ts:15-19` |
| There is **no `success` boolean** on `RequestLog` | `prisma/schema.prisma:80-106`; `20261022162245_init/migration.sql:52-71` |
| Provider error codes are a closed union of six; HTTP mapping lives in the controller | `src/modules/providers/base.provider.ts:15-21`; `gateway.controller.ts:132-159` |
| `RETRYABLE_CODES` has **four** members, not five | `src/modules/providers/resilience.service.ts:5-10` |
| `execute()`'s third argument is already an options object `{ budgetMs?: number }` | `resilience.service.ts:34-38` |
| `ResilienceService` retries/falls back but reports nothing outward | `resilience.service.ts:34-125` |
| Telemetry: `logError()` exists, is **never called**, and requires `statusCode`; `TelemetryModule` is **not** `@Global` (`PrismaModule` is) | `telemetry.module.ts:32-50` |
| `AllExceptionsFilter` builds the envelope; it is **not** modified by Phase 1 | `src/common/filters/all-exceptions.filter.ts:87-147` |
| Validation errors carry `param`, and `chat-contract` asserts it | `chat-completion.schema.ts:35-39,175-180`; `test/chat-contract.test.js:13-20` |
| `SpendService` aggregates `RequestLog.cost` (breaks on rename); `InsightsService` never reads `cost` | `spend.module.ts:49,63`; `insights.service.ts:10-36` |
| `logging.interceptor.ts` reads `request.provider` / `request.model`, which nothing sets | `src/common/interceptors/logging.interceptor.ts:44-45` |
| 53 tests in 8 suites; the `test` script lists them explicitly | `package.json:13` |

**Correction to the brief:** the "existing `success` boolean" does not exist at HEAD. The boolean-shaped signal today is `statusCode` (default `0`) plus nullable `errorCode`; the replace-vs-keep decision applies to `statusCode` (§3.1). Any "backfill `success=true`" instruction is impossible against this schema.

### 2.2 What later phases need from Phase 1

Shaped now or paid for with a rewrite: `RequestLog.credentialId` / `RequestAttempt.credentialId` / `RequestContext.apiKeyId` as **plain strings, no FK** (BYOK); parent `status`, `failureClass`, requested-vs-served model, `attemptCount`, `totalCost` plus `(userId,createdAt)`, `(provider,createdAt)`, `(failureClass,createdAt)` (Phase 4 analytics); user-scoped append-only `ModelPricing` with effective dating so `pricingId` is a snapshot (governance); `isStream`, `timeToFirstTokenMs`, `providerRequestId` present and wired `false`/`null` (streaming — adding them later is a second migration); `attemptIndex`, `attemptOnTarget`, `isFallback`, `retryAfterMs` and the latency split behind the `onAttempt` contract (retry tuning); `traceId` on both tables and `apiKeyId` on the parent, already non-unique and indexed (self-serve lookup).

## 3. Data model

### 3.1 `RequestLog`

Before (`schema.prisma:80-106`): `id, traceId, requestId, userId, apiKeyId?, modelId?, provider?, statusCode(0), latencyMs(0), promptTokens?, completionTokens?, totalTokens?, cost Float?, errorCode?, errorMessage?, createdAt` + relations + 4 indexes.

```prisma
enum RequestStatus {
  PROCESSING
  SUCCESS
  FAILED
}
enum AttemptStatus {
  SUCCEEDED
  FAILED
}
enum FailureClass {
  CALLER_FAULT
  AUTH_FAULT // reserved: unreachable in Phase 1, api-key.guard rejects first
  RATE_LIMIT
  TIMEOUT
  PROVIDER_UNAVAILABLE
  PROVIDER_ERROR
  CONFIGURATION
  INTERNAL // reserved
  ABANDONED
}

model RequestLog {
  id               String        @id @default(cuid())
  traceId          String
  requestId        String
  userId           String
  apiKeyId         String?
  modelId          String?
  requestedModel   String        // alias the caller sent; never null
  servedModel      String?       // upstream model that produced the response
  provider         String?
  status           RequestStatus @default(PROCESSING)
  statusCode       Int           @default(0) // HTTP status; 0 = no response produced
  failureClass     FailureClass?
  attemptCount     Int           @default(0)
  fallbackUsed     Boolean       @default(false)
  credentialId     String?       // Phase 2 BYOK, no FK yet
  isStream         Boolean       @default(false) // caller intent only; Phase 1 never streams
  currency         String?       // ISO-4217 of the winning price row
  startedAt        DateTime      @default(now())
  finishedAt       DateTime?
  latencyMs        Int           @default(0) // end-to-end
  promptTokens     Int?
  completionTokens Int?
  totalTokens      Int?
  totalCost        Decimal?      @db.Decimal(18, 10) // was cost Float?
  pricingId        String?
  pricing          ModelPricing? @relation(fields: [pricingId], references: [id], onDelete: SetNull)
  errorCode        String?       // wire code as the client sees it
  errorMessage     String?       // sanitized, <= 500 chars
  createdAt        DateTime      @default(now())
  user             User             @relation(fields: [userId], references: [id])
  apiKey           ApiKey?          @relation(fields: [apiKeyId], references: [id])
  model            Model?           @relation(fields: [modelId], references: [id])
  attempts         RequestAttempt[]
  @@index([traceId])
  @@index([userId, createdAt])
  @@index([provider, createdAt])
  @@index([status, startedAt])
  @@index([failureClass, createdAt])
  @@index([apiKeyId])
  @@index([createdAt])
  @@index([pricingId])
}
```

**Enums are one value per line** (`prisma validate` rejects the compact form, `P1012`). **Reserved members:** `AUTH_FAULT` and `INTERNAL` stay in the taxonomy but are documented as reserved; `AUTH_FAULT` is unreachable in Phase 1 because `api-key.guard.ts` rejects before the controller runs, so no row exists to carry it.

**Replace vs keep.** Keep `statusCode` (wire contract, read by `insights.service.ts:27`) and add `status` as the lifecycle field. Do **not** add `success`: it is derivable from `status` and would let three fields disagree. `cost` is **renamed** to `totalCost` and widened to `Decimal`; every existing value is `NULL` (the only writer hardcodes it), so nothing is lost.

**`errorCode` stores the wire code, never an internal enum member.** `classifyException` normalises internally but the persisted and returned string is what the client already receives (`PROVIDER_TIMEOUT`, `MODEL_NOT_FOUND`, `UNSUPPORTED_FEATURE`, …). This is what lets §4.3 check existing rows and §6.4 reproduce bodies.

**Compile fixes required by the rename — exactly two files.** `src/modules/gateway/gateway.service.ts:114` `cost: null` → `totalCost: null`; `src/modules/spend/spend.module.ts:49,63` `_sum: { cost: true }` → `_sum: { totalCost: true }` ×2. `SpendService`'s returned key becomes `_sum.totalCost`; no controller consumes it today, so `/spend/*` responses are unchanged.

**`insights.service.ts` is not modified in Phase 1.** It never reads `cost` — it aggregates `promptTokens/completionTokens/totalTokens` and selects `traceId, provider, statusCode, latencyMs, tokens, errorCode, createdAt, model.name` — so the rename cannot break it, and no analytics field is added to any response (§1, §10).

### 3.2 `RequestAttempt` (new)

```prisma
model RequestAttempt {
  id                 String         @id @default(cuid())
  requestLogId       String
  requestLog         RequestLog     @relation(fields: [requestLogId], references: [id], onDelete: Cascade)
  attemptIndex       Int            // 0-based across all targets and retries
  attemptOnTarget    Int            @default(0) // 0 = first try of this target
  isFallback         Boolean        @default(false) // targetIndex > 0
  provider           String
  model              String         // public alias (RouteTarget.modelName)
  servedModel        String?        // upstream name sent / echoed back
  credentialId       String?        // Phase 2 BYOK
  status             AttemptStatus
  isStream           Boolean        @default(false)
  providerStatus     Int?           // ProviderError.providerStatus
  failureClass       FailureClass?  // null when SUCCEEDED
  errorCode          String?        // wire code, e.g. PROVIDER_TIMEOUT
  errorMessage       String?        // sanitized, <= 500
  retryAfterMs       Int?           // reserved; always null in Phase 1
  latencyMs          Int            // wall time of this attempt
  upstreamLatencyMs  Int?           // ProviderResponse.latencyMs on success
  overheadMs         Int?           // latencyMs - upstreamLatencyMs, clamped >= 0
  timeToFirstTokenMs Int?           // reserved for streaming; always null
  promptTokens       Int?
  completionTokens   Int?
  totalTokens        Int?
  pricingId          String?
  pricing            ModelPricing?  @relation(fields: [pricingId], references: [id], onDelete: SetNull)
  inputCost          Decimal?       @db.Decimal(18, 10)
  outputCost         Decimal?       @db.Decimal(18, 10)
  totalCost          Decimal?       @db.Decimal(18, 10)
  providerRequestId  String?        // response.id
  createdAt          DateTime       @default(now())
  @@unique([requestLogId, attemptIndex])
  @@index([requestLogId])
  @@index([provider, createdAt])
  @@index([failureClass, createdAt])
  @@index([pricingId])
}
```

`@@unique([requestLogId, attemptIndex])` turns a duplicate append into a catchable `P2002` no-op instead of a doubled row.

### 3.3 `ModelPricing` (new)

```prisma
model ModelPricing {
  id                    String   @id @default(cuid())
  provider              String   // lowercase, matches RouteTarget.provider
  model                 String   // upstream id, matches RouteTarget.upstreamModel
  userId                String?  // null = global, set = user override
  user                  User?    @relation(fields: [userId], references: [id], onDelete: Cascade)
  currency              String   @default("USD")
  inputPricePerMillion  Decimal  @db.Decimal(18, 8)
  outputPricePerMillion Decimal  @db.Decimal(18, 8)
  effectiveFrom         DateTime @default(now())
  effectiveTo           DateTime? // null = open-ended
  isActive              Boolean  @default(true)
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  requestLogs           RequestLog[]
  requestAttempts       RequestAttempt[]
  @@unique([provider, model, userId, effectiveFrom])
  @@index([provider, model, isActive, effectiveFrom])
  @@index([userId])
  @@index([model])
}
```

**Selection (implement exactly):** `isActive = true`, matching `provider` + `model`, `effectiveFrom <= at`, `OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }]`, `AND: [{ OR: [{ userId }, { userId: null }] }]`; `take: 10` ordered by `effectiveFrom desc`; then pick in memory — any `userId !== null` row beats every global row, newest `effectiveFrom` wins inside a tier. The in-memory tie-break is mandatory: Postgres sorts `NULLS FIRST` on `DESC`, so `orderBy: { userId: 'desc' }` would rank the global row first.

**Accepted limitation:** Postgres treats `NULL`s as distinct in a composite unique, so a global row can be duplicated. Phase 1 enforces uniqueness in `prisma/seed.js` (findFirst-then-create) and exposes no write API; Phase 2 adds a partial unique index `... WHERE "userId" IS NULL` in its own migration — do not hand-add it now, `prisma migrate dev` will diff it away. **Rows are append-only:** never update amounts or dates, insert a new row with a later `effectiveFrom`, which is what makes `pricingId` a real snapshot.

### 3.4 Decimal precision

| Column | Type | Why |
|---|---|---|
| `*PricePerMillion` | `Decimal(18, 8)` | published prices have ≤ 4 decimals in USD/M; 8 covers sub-cent values |
| `totalCost` / `inputCost` / `outputCost` | `Decimal(18, 10)` | smallest real charge is 1 token at `$0.05/M` = `$0.00000005`; `Float` loses cents at scale |

Compute in `Prisma.Decimal` (`toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP)` per side, then add). Never JS `number`. `toDecimalPlaces` **rounds, it does not pad**: zero serialises as `"0"`, and 1000 prompt + 500 completion on `gpt-4o-mini` (`0.15`/`0.60` per 1M) is exactly `"0.00045"`. Assert that string; never ten characters of padding. Costs live in the database only in Phase 1; no cost is serialised over HTTP.

## 4. Migration strategy

Name: `20261102090000_requestlog_foundation`.

### 4.1 Generate without a shadow database

Neon cannot create the throwaway shadow DB `prisma migrate dev` needs (`P3014`).

**Path A (rigorous, needs a Neon branch):** temporarily add `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")` to `datasource db` — local only, never commit — point it at an empty branch, then:

```powershell
$env:SHADOW_DATABASE_URL = "postgresql://.../shadow?sslmode=require"
npx prisma migrate dev --create-only --name requestlog_foundation
```

`migrate dev` always prefixes `<timestamp>_`, producing `prisma/migrations/<timestamp>_requestlog_foundation/`; rename the folder to `20261102090000_requestlog_foundation` afterwards if the fixed name matters, because `migrate dev` never emits that timestamp itself.

**Path B (no shadow DB, used here):**

```powershell
New-Item -ItemType Directory -Force prisma/migrations/20261102090000_requestlog_foundation
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma `
  --to-schema-datamodel prisma/schema.prisma --script `
  --output prisma/migrations/20261102090000_requestlog_foundation/migration.sql
```

Use `--output`, never `>`: PowerShell redirection writes UTF-16 and Prisma cannot read it.

### 4.2 Hand-edit the SQL (mandatory)

`migrate diff` cannot see renames and emits `DROP COLUMN "cost"` + `ADD COLUMN "totalCost"`. Replace that with a rename and insert the backfill. Keep exactly this order; **foreign keys come last**, because a FK cannot reference a table that does not exist yet.

```sql
-- 1. CREATE TYPE "RequestStatus" / "AttemptStatus" / "FailureClass"
-- 2. CREATE TABLE "ModelPricing" (+ its unique index). No FK yet.
-- 3. CREATE TABLE "RequestAttempt" (columns only, no FK yet).
-- 4. ALTER TABLE "RequestLog" ADD COLUMN — "status" is NULLABLE, no default, on purpose
ALTER TABLE "RequestLog"
  ADD COLUMN "requestedModel" TEXT,        ADD COLUMN "servedModel" TEXT,
  ADD COLUMN "status" "RequestStatus",     ADD COLUMN "failureClass" "FailureClass",
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "credentialId" TEXT,          ADD COLUMN "isStream" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "currency" TEXT,              ADD COLUMN "pricingId" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3),     ADD COLUMN "finishedAt" TIMESTAMP(3);
-- 5. UPDATE backfill (real columns only — there is no "success" column)
UPDATE "RequestLog" rl SET "requestedModel" = COALESCE(m."name", 'unknown')
  FROM "Model" m WHERE m."id" = rl."modelId";
UPDATE "RequestLog" SET "requestedModel" = 'unknown' WHERE "requestedModel" IS NULL;
UPDATE "RequestLog" SET
  "status"       = CASE WHEN "errorCode" IS NULL THEN 'SUCCESS'::"RequestStatus"
                        ELSE 'FAILED'::"RequestStatus" END,
  "startedAt"    = "createdAt",
  "finishedAt"   = "createdAt",
  "attemptCount" = 0,
  "fallbackUsed" = false;
-- 6. ALTER COLUMN ... SET NOT NULL + SET DEFAULT
ALTER TABLE "RequestLog"
  ALTER COLUMN "requestedModel" SET NOT NULL,
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'PROCESSING',
  ALTER COLUMN "startedAt" SET NOT NULL,
  ALTER COLUMN "startedAt" SET DEFAULT CURRENT_TIMESTAMP;
-- 7. rename + convert (all existing values are NULL, so USING cannot fail)
ALTER TABLE "RequestLog" RENAME COLUMN "cost" TO "totalCost";
ALTER TABLE "RequestLog" ALTER COLUMN "totalCost" TYPE DECIMAL(18,10) USING "totalCost"::numeric(18,10);
-- 8. indexes
-- 9. foreign keys LAST
ALTER TABLE "RequestLog"     ADD CONSTRAINT "RequestLog_pricingId_fkey" ...
ALTER TABLE "RequestAttempt" ADD CONSTRAINT "RequestAttempt_requestLogId_fkey" ...
ALTER TABLE "RequestAttempt" ADD CONSTRAINT "RequestAttempt_pricingId_fkey" ...
```

**The backfill is `errorCode`-based, not `success`-based.** The only writer today inserts `statusCode: 200, errorCode: null` on success and inserts nothing on failure. Hence `errorCode IS NULL → 'SUCCESS'`, `errorCode IS NOT NULL → 'FAILED'`, `statusCode` untouched. Legacy rows get `attemptCount = 0` **because attempt tracking did not exist before this migration** — they are known-incomplete by construction, not corrupted.

**Concurrency:** the two backfill `UPDATE`s assume no writes land mid-migration. The §4.4 window stops the app first; do not run this SQL against a live writer.

### 4.3 Migration verification (all checks must pass)

Static checks run in Task 5, against the file, before anything is applied:

| # | Check | Pass condition |
|---|---|---|
| V1 | **Rename, not drop/add** | SQL contains `RENAME COLUMN "cost" TO "totalCost"` and `DECIMAL(18,10)`; contains **no** `DROP COLUMN "cost"` and **no** `ADD COLUMN "totalCost"` |
| V2 | **FK ordering** | every `ADD CONSTRAINT … FOREIGN KEY` line number is greater than the `CREATE TABLE` line of **both** referenced tables; no FK before its table |
| V3 | **Column coverage** | every field in §3.1–§3.3 appears in the SQL exactly once (enum types + `ALTER TABLE ADD COLUMN` + `CREATE TABLE`), and no column exists in the SQL that is absent from `schema.prisma` |
| V4 | **Backfill completeness** | the SQL sets `status`, `startedAt`, `finishedAt`, `requestedModel` for every row, and `SET NOT NULL` follows the `UPDATE`, never precedes it |

Runtime checks run in Task 11, inside the window, against the live database:

| # | Check | Query / command | Pass condition |
|---|---|---|---|
| V5 | **Row preservation** | `SELECT COUNT(*) FROM "RequestLog"` before and after | identical |
| V6 | **No null backfill** | `SELECT COUNT(*) FROM "RequestLog" WHERE "status" IS NULL OR "startedAt" IS NULL OR "finishedAt" IS NULL OR "requestedModel" IS NULL` | `0` |
| V7 | **Payload preserved** | `SELECT md5(string_agg(id||traceId||requestId||"statusCode"||coalesce("totalTokens",-1)||coalesce("errorCode",'-')||"createdAt", ',' ORDER BY id)) FROM "RequestLog"` before and after | identical |
| V8 | **Cost column** | `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name='RequestLog' AND column_name='totalCost'` and `SELECT COUNT("totalCost") FROM "RequestLog"` | `numeric, 18, 10`; count `0` (all legacy values NULL) |
| V9 | **Schema/SQL agree** | `npx prisma migrate status` **and** `npx prisma migrate diff --from-url $env:DATABASE_URL --to-schema-datamodel prisma/schema.prisma` | "Database schema is up to date"; **empty diff** (this works without a shadow DB, unlike the `--from-migrations` form) |
| V10 | **FK integrity** | `SELECT COUNT(*) FROM "RequestAttempt"` and confirm `RequestLog_pricingId_fkey` is nullable | `0`; `is_nullable = YES` |
| V11 | **Seed landed** | `SELECT COUNT(*) FROM "ModelPricing"` | `4`, one per verified OpenAI model |

Rehearse V5–V11 on a Neon **branch** first. If any check fails there, the primary database is never touched.

### 4.4 Apply window (Task 11)

The migration is applied **only after every line of Phase 1 application code exists** (Tasks 1–10). Applying earlier leaves the schema ahead of the code: `prisma generate` would be current while `gateway.service.ts` still writes `cost` (broken), and `RequestLogService` would write `status` into a database that has no such column.

Single-instance sequence, one window, ~10 minutes:

1. Stop accepting traffic (stop the process or put the proxy in maintenance).
2. Record V5 and V7 baselines.
3. `npx prisma migrate deploy` — no shadow DB, no prompt, never resets.
4. `npx prisma generate` — already run in Task 4; repeat to guarantee the client matches.
5. `npx prisma db seed` — idempotent; seeds users, keys, models **and** the four model prices.
6. Run V5–V11. Index expectation: the migration executes **14** `CREATE INDEX` statements (12 btree + 2 unique), leaving **20** indexes across the three tables including primary keys — `RequestLog` 9, `RequestAttempt` 6, `ModelPricing` 5. V10 must match that set exactly.
7. Deploy the Phase 1 build (same commit as Tasks 1–10).
8. Smoke test: one `mock` completion, confirm a `SUCCESS` row with `startedAt`/`finishedAt` and `attemptCount=1`; one invalid body, confirm a `FAILED`/`CALLER_FAULT` row with zero attempts.
9. Resume traffic.

**Between Task 4 and Task 11 the app must not be started against Neon.** Tests use fakes and stay green; a live boot would fail on the first log write. This is an operational constraint, not a code defect.

### 4.5 Rollback

Forward-only; inverse by hand: drop `RequestAttempt`, drop `ModelPricing`, drop new indexes/FKs, drop added columns, `ALTER COLUMN "totalCost" TYPE DOUBLE PRECISION`, `RENAME` back to `cost`, drop the three enums. Loses attempts and costs; `User`, `ApiKey`, `Model` untouched — `Model` is not modified in Phase 1.

## 5. New module layout & exact signatures

TypeScript, NestJS provider style, no new npm packages (Node built-ins + existing `@prisma/client`, `@nestjs/*`, `zod`).

### 5.1 `src/common/context/request-context.ts`

```ts
export interface RequestContextUser { id: string; apiKeyId: string | null; }

export interface RequestContext {
  readonly traceId: string; readonly requestId: string;
  readonly userId: string; readonly apiKeyId: string | null;
  readonly requestedModel: string; readonly isStream: boolean; readonly startedAt: Date;
}

export interface CreateRequestContextInput {
  traceId: string; requestId: string; user: RequestContextUser;
  requestedModel: string; isStream?: boolean; now?: Date;
}

export function createRequestContext(input: CreateRequestContextInput): RequestContext;
export function requestedModelFromBody(body: unknown): string; // body.model when a non-empty string, else 'unknown'
```

**`userId` is the only user field.** There is no `context.user` and no `context.logId`: the parent row id is a local `const logId` inside `GatewayService.createCompletion`, created by `await requestLogs.start(...)`. Adding a mutable copy of it to an otherwise immutable context invites two sources of truth. Consumers that need the id (Phase 2 retrieval) get it from `start()`'s return value.

### 5.2 `src/common/errors/error-taxonomy.ts`

```ts
import type { ProviderErrorCode } from '../../modules/providers/base.provider';

export type FailureClass =
  | 'CALLER_FAULT' | 'AUTH_FAULT' | 'RATE_LIMIT' | 'TIMEOUT' | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ERROR' | 'CONFIGURATION' | 'INTERNAL' | 'ABANDONED';

export type GatewayErrorCode =
  | ProviderErrorCode
  | 'VALIDATION_ERROR' | 'UNSUPPORTED_FEATURE' | 'MODEL_NOT_FOUND' | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR' | 'API_KEY_INVALID' | 'API_KEY_INACTIVE' | 'RATE_LIMIT_ERROR'
  | 'NOT_FOUND' | 'INTERNAL_ERROR';

export interface ErrorDefinition {
  readonly failureClass: FailureClass;
  readonly httpStatus: number; // numeric: keeps this module free of @nestjs/common
  readonly wireCode: string;   // exact code the client already receives
  readonly message: string;    // exact message the client already receives
}

export const ERROR_DEFINITIONS: Readonly<Record<GatewayErrorCode, ErrorDefinition>>;
export function describeErrorCode(code: GatewayErrorCode): ErrorDefinition;
export function isGatewayErrorCode(value: string): value is GatewayErrorCode;
export function errorDefinitionForHttpStatus(status: number, wireCode?: string): ErrorDefinition;
```

### 5.3 `src/common/errors/failure-classifier.ts`

```ts
import { ProviderError } from '../../modules/providers/base.provider';

export interface ClassifiedError {
  /** Internal, for logging and routing. */
  errorCode: GatewayErrorCode;
  /** What the client already receives; unknown code strings pass through unchanged. */
  wireCode: string;
  failureClass: FailureClass;
  httpStatus: number;
  message: string;              // client-safe
  param?: string;               // caller rejections only; reproduced verbatim
  providerStatus?: number;
  retryable: boolean;
  isProviderError: boolean;
}

export function failureClassForProviderCode(code: ProviderErrorCode): FailureClass;
export function isRetryableProviderCode(code: ProviderErrorCode): boolean;
export function classifyProviderError(error: ProviderError): ClassifiedError;
export function classifyCallerRejection(input: {
  code: 'VALIDATION_ERROR' | 'UNSUPPORTED_FEATURE'; message: string; param?: string;
}): ClassifiedError;
export function classifyException(error: unknown): ClassifiedError; // ProviderError | HttpException | Error
export function sanitizeErrorMessage(value: unknown, maxLength?: number): string | null; // default 500
```

**`wireCode` vs `errorCode` is not cosmetic.** `AllExceptionsFilter` passes any string `body.code` through (`all-exceptions.filter.ts:110-113`), and `ErrorCode` contains members that are **not** in `GatewayErrorCode` (`EMAIL_ALREADY_EXISTS`). So: recognised codes map to a `GatewayErrorCode`; unrecognised string codes are preserved in `wireCode` with `errorCode: 'INTERNAL_ERROR'`-shaped fallback for internal use. Persisted `RequestLog.errorCode` / `RequestAttempt.errorCode` always take `wireCode`, so the database matches the client.

`isRetryableProviderCode` replaces the local `RETRYABLE_CODES` set in `resilience.service.ts:5-10` — **four** members there today (`PROVIDER_TIMEOUT`, `PROVIDER_RATE_LIMIT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`), not five — so retry policy has one owner.

**`toHttpException(classified)`** lives in `failure-classifier.ts` (no `@nestjs/common` import there would be nicer, but the filter import is acceptable; alternatively put it in `gateway.controller.ts` — pick one and keep `mapProviderError` on the controller, because `error-contract.test.js:116-134` calls it directly). It must produce:

- provider errors → body `{ code: wireCode, message, statusCode }` (no `param` key, exactly as today);
- caller rejections → body `{ code: wireCode, message, param, statusCode }` (key always present, `undefined` when absent, exactly as today);
- everything else → the original exception, untouched.

### 5.4 `src/modules/pricing/` — `pricing.module.ts`, `pricing.service.ts`

```ts
@Module({ providers: [PricingService, CostCalculator], exports: [PricingService, CostCalculator] })
export class PricingModule {}

export interface PricingSnapshot {
  pricingId: string; currency: string;
  inputPricePerMillion: Prisma.Decimal; outputPricePerMillion: Prisma.Decimal;
}
export interface ResolvePricingInput {
  provider: string; model: string /* RouteTarget.upstreamModel */;
  userId?: string | null; at?: Date; currency?: string; // default 'USD'
}

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}
  async resolvePricing(input: ResolvePricingInput): Promise<PricingSnapshot | null>;
  toSnapshot(row: ModelPricing): PricingSnapshot;
  clearCache(): void; // test seam; TTL 60_000ms, max 1000 entries
}
```

Cache only snapshots, never `null` (a seed added after boot must become visible within one TTL), keyed `${provider}:${model}:${userId ?? '*'}:${currency}`. `currency` is part of `ResolvePricingInput` with default `'USD'`, so the key is always defined and never contains `undefined`.

### 5.5 `src/modules/pricing/cost-calculator.ts`

```ts
export interface CostInput {
  promptTokens?: number | null; completionTokens?: number | null; pricing: PricingSnapshot | null;
}
export interface CostBreakdown {
  pricingId: string; currency: string;
  inputCost: Prisma.Decimal | null; outputCost: Prisma.Decimal | null; totalCost: Prisma.Decimal | null;
}
export const TOKENS_PER_PRICE_UNIT = 1_000_000;
export const COST_SCALE = 10;

/** Pure, DB-free. Exported so tests can exercise money math without Prisma. */
export function calculateCost(input: CostInput): CostBreakdown | null;

@Injectable()
export class CostCalculator {
  constructor(private readonly pricing: PricingService) {}
  /** TOTAL: catches every error (DB down, decimal overflow) and returns null. Never throws. */
  async calculate(input: {
    provider: string; model: string; userId?: string | null; at?: Date;
    promptTokens?: number | null; completionTokens?: number | null;
  }): Promise<CostBreakdown | null>;
}
```

**`CostCalculator.calculate()` is total.** It wraps the `PricingService` lookup and the money math in `try/catch` and returns `null` — never a rejected promise. Pricing runs on the **post-success** path, so a thrown pricing error would turn a paid successful completion into a `500`. `null` means "cost unknown" (§6.6). Necessary but not sufficient: `GatewayService` also calls it inside the guarded helper that wraps logging (`reportLoggingFailure`, §6.8). Both layers are required; neither alone is claimed to be enough. Tested by §8.3 scenario 8.

`PricingSnapshot` / `CostBreakdown` are **declared in `pricing.service.ts`** and re-exported by `cost-calculator.ts` to avoid a circular import.

### 5.6 `src/common/observability/attempt-observation.ts`

**Not** in `src/modules/logging/`: `providers/resilience.service.ts` emits this type, and `providers/` must never import the logging module.

```ts
import type { RouteTarget } from '../../modules/router/router.service';

export interface AttemptObservation<T> {
  attemptIndex: number;    // 0-based across the whole request
  attemptOnTarget: number; // 0-based within this target (retry index)
  isFallback: boolean; target: RouteTarget;
  status: 'SUCCEEDED' | 'FAILED'; latencyMs: number;
  result?: T;        // present iff SUCCEEDED
  error?: unknown;   // present iff FAILED
  startedAt: Date; finishedAt: Date;
}

/** The ONLY place the latency split is computed. */
export interface LatencySplit { upstreamLatencyMs: number | null; overheadMs: number | null }
export function deriveLatencySplit(observation: AttemptObservation<unknown>): LatencySplit;
```

**Authoritative split rule.** `upstreamLatencyMs = observation.result?.latencyMs ?? null` (`ProviderResponse.latencyMs`, measured inside the adapter). `overheadMs = upstreamLatencyMs === null ? null : Math.max(0, observation.latencyMs - upstreamLatencyMs)`. Failed attempts have no provider timing, so **both stay `null`** — no invention. `Math.max(0, …)` absorbs clock skew that would otherwise persist a negative overhead.

### 5.7 `src/modules/logging/request-log.types.ts`

```ts
import type { FailureClass } from '../../common/errors/error-taxonomy';
import type { Prisma } from '@prisma/client';
import type { AttemptObservation } from '../../common/observability/attempt-observation';

export type RequestLogStatus = 'PROCESSING' | 'SUCCESS' | 'FAILED';
export type AttemptStatus = 'SUCCEEDED' | 'FAILED';

export interface StartRequestLogInput {
  traceId: string; requestId: string; userId: string; apiKeyId: string | null;
  requestedModel: string; isStream?: boolean; startedAt: Date;
}

export interface AttemptRecordInput {
  requestLogId: string; attemptIndex: number; attemptOnTarget: number; isFallback: boolean;
  provider: string; model: string; servedModel: string | null; credentialId?: string | null;
  status: AttemptStatus; isStream: boolean; providerStatus?: number | null;
  failureClass?: FailureClass | null; errorCode?: string | null; errorMessage?: string | null;
  retryAfterMs?: number | null; latencyMs: number;
  upstreamLatencyMs?: number | null; overheadMs?: number | null;
  timeToFirstTokenMs?: number | null; promptTokens?: number | null;
  completionTokens?: number | null; totalTokens?: number | null; pricingId?: string | null;
  inputCost?: Prisma.Decimal | null; outputCost?: Prisma.Decimal | null;
  totalCost?: Prisma.Decimal | null; providerRequestId?: string | null; createdAt: Date;
}

/** Single mapping from a raw observation to a persistable attempt row. */
export type AttemptRecordDraft = Omit<AttemptRecordInput, 'requestLogId'>;
export function toAttemptRecord(
  observation: AttemptObservation<{
    response: { id?: string; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    latencyMs: number;
  }>,
  classify: (error: unknown) => { failureClass: FailureClass | null; wireCode: string | null; message: string | null; providerStatus?: number | null },
): AttemptRecordDraft;

export interface FinalizeSuccessInput {
  requestLogId: string; statusCode: number /* 200 in Phase 1 */; modelId: string | null;
  requestedModel: string; servedModel: string; provider: string;
  attemptCount: number; fallbackUsed: boolean; currency: string | null;
  promptTokens: number | null; completionTokens: number | null; totalTokens: number | null;
  pricingId: string | null; totalCost: Prisma.Decimal | null; latencyMs: number; finishedAt: Date;
}

export interface FinalizeFailureInput {
  requestLogId: string; statusCode: number; failureClass: FailureClass;
  errorCode: string; errorMessage: string | null; modelId?: string | null;
  provider?: string | null; servedModel?: string | null; attemptCount: number;
  fallbackUsed: boolean; latencyMs: number; finishedAt: Date;
}
```

**Latency split — one path.** `toAttemptRecord` calls `deriveLatencySplit(observation)` and puts both numbers on the draft. `appendAttempt` persists `upstreamLatencyMs` and `overheadMs` **verbatim**; it never recomputes them, and nothing else computes them. `overheadMs` is therefore never absent when `upstreamLatencyMs` exists, which is what §8.3 scenario 1 asserts.

**Reserved fields are written `null`, not omitted:** `retryAfterMs` (Phase 3 parses `Retry-After`), `timeToFirstTokenMs` (Phase 6), `credentialId` (Phase 2). `model` is the public alias from `target.modelName`; `servedModel` is `result.response.model ?? target.upstreamModel`.

### 5.8 `src/modules/logging/request-log.service.ts`

```ts
@Injectable()
export class RequestLogService implements OnModuleInit, OnModuleDestroy {
  static readonly STALE_PROCESSING_MS = 15 * 60 * 1000;
  static readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  constructor(private readonly prisma: PrismaService, private readonly telemetry: TelemetryService) {}
  onModuleInit(): void;    // void this.sweepStaleProcessing() — fire-and-forget
  onModuleDestroy(): void; // clearInterval(this.sweepTimer)
  /** Returns null (never throws) when the row cannot be written. */
  async start(input: StartRequestLogInput): Promise<{ id: string } | null>;
  /** Never throws. Swallows + reports. */
  async appendAttempt(input: AttemptRecordInput): Promise<void>;
  /** Guarded by status = PROCESSING; true only when this call finalized the row. */
  async finalizeSuccess(input: FinalizeSuccessInput): Promise<boolean>;
  async finalizeFailure(input: FinalizeFailureInput): Promise<boolean>;
  /** `$executeRaw`, not `updateMany`. Returns rows swept; never throws. */
  async sweepStaleProcessing(olderThanMs?: number): Promise<number>;
}
```

### 5.9 `src/modules/logging/request-log.module.ts`

```ts
@Module({ imports: [TelemetryModule], providers: [RequestLogService], exports: [RequestLogService] })
export class RequestLogModule {}
```

**`imports: [TelemetryModule]` is mandatory** — `TelemetryModule` is not `@Global` (`telemetry.module.ts:46-50`), unlike `PrismaModule`, so `RequestLogService`'s `TelemetryService` parameter cannot resolve and Nest throws at boot without it.

## 6. Behaviour specs

### 6.1 When the PROCESSING row is created

**Decision: before route resolution — at the top of `GatewayService.createCompletion`; rejected requests get theirs from `recordRejectedRequest` before the exception leaves the controller.**

1. `GatewayController.createCompletion` keeps its **exact 4-argument signature** `(body, user, traceId, requestId)` — `chat-contract.test.js` and `error-contract.test.js` call it that way — and builds the context internally: `createRequestContext({ user, traceId, requestId, requestedModel: requestedModelFromBody(body), isStream: body?.stream === true })`.
2. It validates. On `ChatRequestValidationError` it awaits the optional call `gatewayService.recordRejectedRequest?.(context, { code, message })` inside `try/catch`, then rethrows the **same** `HttpException` as today.
3. `GatewayService.createCompletion` awaits `requestLogs.start(...)` as its first statement, keeps `const logId = started?.id ?? null`, then `router.resolveRoute(...)`.

Known at `start()`: `traceId`, `requestId`, `userId`, `apiKeyId`, `requestedModel`, `isStream`, `startedAt`. Unknown and nullable by design: `modelId`, `provider`, `servedModel`, tokens, cost; `statusCode` stays `0`. Why before routing: routing is the first query that can hang on a cold Neon compute, and `MODEL_NOT_FOUND` (404) is thrown by the router — creating the row afterwards makes the most common caller error invisible. Cost: a spammer writes one ~200-byte `FAILED` row per invalid request; accepted, and prunable via `(status, startedAt)`.

**The controller's optional call is load-bearing.** Existing suites construct `new GatewayController({ createCompletion })` — a fake with no `recordRejectedRequest`. `?.()` keeps those tests passing without editing them, and the surrounding `try/catch` guarantees a logging failure can never turn a 400 into a 500.

`isStream` records **caller intent only**. Phase 1 rejects `stream: true` with `UNSUPPORTED_FEATURE`, so an accepted request always streams nothing; the column exists so Phase 6 is a write, not a migration.

### 6.2 Attempts appended immediately, never batched

**Decision: one insert per attempt, started synchronously from `onAttempt`, awaited via `Promise.allSettled` only just before finalization.**

- "A hung request must leave evidence": if attempt 1 times out and attempt 2 hangs until the pod dies, batching writes nothing; immediate append leaves attempt 1 on disk.
- Ordering comes from `attemptIndex` and `@@unique([requestLogId, attemptIndex])`. The append is not awaited inside the resilience loop, so it adds no latency to the next attempt; the write is registered and awaited once, before finalization.
- If `start()` returned `null`, no attempts are written: there is no parent, and orphan attempts are worse than nothing.

**Exact write order (implement literally).** `onAttempt` starts the write synchronously and pushes the promise; it never awaits inline:

```ts
const pendingWrites: Promise<void>[] = [];

const onAttempt = (observation: AttemptObservation<ProviderResponse>) => {
  if (logId === null) return;
  pendingWrites.push((async () => {
    const draft = toAttemptRecord(observation, classifyAttemptError);
    const cost = await this.costCalculator.calculate({
      provider: observation.target.provider, model: observation.target.upstreamModel,
      userId: context.userId, at: context.startedAt,
      promptTokens: draft.promptTokens ?? null, completionTokens: draft.completionTokens ?? null,
    });
    await this.requestLogs.appendAttempt({ ...draft, ...(cost ?? {}), requestLogId: logId });
  })());
};
```

`await Promise.allSettled(pendingWrites)` runs **before** `finalizeSuccess` and before `finalizeFailure`, so attempt rows are on disk before the parent leaves `PROCESSING`. `appendAttempt` is total (§5.8) and `CostCalculator.calculate` is total (§5.5), so `allSettled` never has a rejection to explain away — and the parent still finalises if one attempt row is lost.

### 6.3 `ResilienceService` reports attempts without coupling

Extend the existing options object; all 13 resilience tests and the `gateway-service.test.js` fake `execute(targets, operation, options)` stay source-compatible:

```ts
export interface ResilienceOptions {
  budgetMs?: number;
  onAttempt?: (observation: AttemptObservation<T>) => void; // synchronous, must not throw
}
async execute<T>(
  targets: RouteTarget[],
  operation: (target: RouteTarget, timeoutMs: number) => Promise<T>,
  options?: ResilienceOptions,
): Promise<T>;
```

| Call site in `execute` | Payload |
|---|---|
| `operation()` resolves | `{ status: 'SUCCEEDED', result, attemptIndex, attemptOnTarget: attempt, isFallback: targetIndex > 0, target, latencyMs, startedAt, finishedAt }`, emitted **before** `recordSuccess` / `return` |
| `operation()` throws | same with `status: 'FAILED', error`, emitted **before** the retry/abandon decision so a retry cannot erase the first failure |
| budget exhausted before an attempt (`resilience.service.ts:63-72`) | no observation; parent fails `PROVIDER_TIMEOUT`, `attemptCount` unchanged |
| all targets cooling down | no observation; parent fails `PROVIDER_UNAVAILABLE` |

Convert the target loop to an indexed loop (`for (let targetIndex = 0; …)`) for `isFallback`; a counter increments `attemptIndex` per emitted observation. The callback runs inside `try { } catch { }`, so a consumer bug cannot change routing. `ProviderOptions` gains `context?: RequestContext` (no `chatCompletion` signature change) for Phase 2 streaming.

### 6.4 Failure classification table (must reproduce today's responses exactly)

`ERROR_DEFINITIONS` is the single source of truth. `GatewayController.mapProviderError()` stays on the controller (the existing `error-contract` test calls it directly) and delegates to the classifier, then rebuilds the **same** `HttpException` body.

The envelope is produced by `AllExceptionsFilter` and is not modified. Every row below must match on **all seven** fields:

```
{ error: { message, type, param, code, trace_id, status_code, timestamp } }
```

| Input | `failureClass` | HTTP | `code` | `type` | `param` | `message` |
|---|---|---|---|---|---|---|
| `PROVIDER_TIMEOUT` | `TIMEOUT` | 504 | `PROVIDER_TIMEOUT` | `server_error` | `null` | `Provider request timed out.` |
| `PROVIDER_RATE_LIMIT` | `RATE_LIMIT` | 429 | `PROVIDER_RATE_LIMIT` | `rate_limit_error` | `null` | `Provider rate limit exceeded.` |
| `PROVIDER_BAD_REQUEST` | `CALLER_FAULT` | 400 | `PROVIDER_BAD_REQUEST` | `invalid_request_error` | `null` | `Provider rejected the request.` |
| `PROVIDER_UNAVAILABLE` | `PROVIDER_UNAVAILABLE` | 502 | `PROVIDER_UNAVAILABLE` | `server_error` | `null` | `Provider is unavailable.` |
| `PROVIDER_NOT_CONFIGURED` | `CONFIGURATION` | 503 | `PROVIDER_NOT_CONFIGURED` | `server_error` | `null` | `Provider is not configured.` |
| `PROVIDER_ERROR` | `PROVIDER_ERROR` | 502 | `PROVIDER_ERROR` | `server_error` | `null` | `Provider request failed.` |
| `VALIDATION_ERROR` | `CALLER_FAULT` | 400 | `VALIDATION_ERROR` | `invalid_request_error` | **as thrown** (`'stream'`, `'messages.0.content'`, …) | original |
| `UNSUPPORTED_FEATURE` | `CALLER_FAULT` | 400 | `UNSUPPORTED_FEATURE` | `invalid_request_error` | **as thrown** | original |
| `HttpException` 401 / 403 | `AUTH_FAULT` (reserved) | 401 / 403 | body `code` or filter default | `authentication_error` / `permission_error` | `null` | original |
| router `MODEL_NOT_FOUND` | `CALLER_FAULT` | 404 | `MODEL_NOT_FOUND` | `not_found_error` | `null` | original |
| `HttpException` 409 / 429 | `CALLER_FAULT` / `RATE_LIMIT` | 409 / 429 | body `code` or filter default | `conflict_error` / `rate_limit_error` | `null` | original |
| any other `Error` | `INTERNAL` | 500 | `INTERNAL_ERROR` | `server_error` | `null` | `Internal server error` |

`retryable = true` only for `PROVIDER_TIMEOUT`, `PROVIDER_RATE_LIMIT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR` — identical to the four members of `RETRYABLE_CODES` today. `providerStatus` is passed to the log but never to the client. `PROVIDER_NOT_CONFIGURED` is not retryable but still falls through to the next target (`resilience.test.js:75`). `AllExceptionsFilter` is **not modified**; responses stay byte-identical — a constraint that covers **every** existing endpoint (§1).

**Why the `param` column matters:** `chat-contract.test.js:13-20` asserts `error.param` is `undefined` or an exact string. A classifier that drops `param` would make `UNSUPPORTED_FEATURE` return `param: null` instead of `param: 'stream'` and silently break that contract. `ClassifiedError.param` and the rebuild path in §5.3 exist for this one reason.

### 6.5 Sanitization

`sanitizeErrorMessage(value, maxLength = 500)`: stringify (empty → `null`); replace `/\bsk-[A-Za-z0-9_\-]{4,}/g`, `/\blg_[A-Za-z0-9_\-]{4,}/g`, `/\bBearer\s+[A-Za-z0-9._\-]+/gi` with `[redacted]`; collapse whitespace and strip control characters; truncate with `…[truncated]`. Applied to `RequestLog.errorMessage`, `RequestAttempt.errorMessage`, and `TelemetryService.logError().errorMessage`; never to the client-facing message (already our own fixed string or the validation message).

**Content is never logged** — no prompt, completion, messages, headers or body, in Phase 1 or in this plan.

**`LOG_CONTENT` is deferred.** It is **not** added to `src/config/env.ts` or `.env.example` in Phase 1. Nothing reads it, and `env.ts:3-8` states the schema holds "only variables the application actually reads". It lands with content logging in the streaming phase.

### 6.6 Cost rules

- Lookup key `(provider = RouteTarget.provider, model = RouteTarget.upstreamModel, userId, at = startedAt, currency = 'USD')` — prices attach to the upstream model, not the alias.
- Per side `cost = tokens / 1_000_000 × pricePerMillion`, `toDecimalPlaces(10, ROUND_HALF_UP)`; `totalCost = inputCost + outputCost` after rounding.
- `pricing === null` → `calculateCost` returns `null`, and attempt + parent store `totalCost = null`, `pricingId = null`, `currency = null`. Never `0`: `0` means free, `null` means unknown.
- `inputCost` needs `promptTokens != null`, `outputCost` needs `completionTokens != null`; `totalCost` is `null` unless both exist. `0` tokens is valid and yields `Decimal(0)`, serialised `"0"`.
- Snapshot: attempt gets `pricingId`, `inputCost`, `outputCost`, `totalCost`; parent gets `pricingId`, `currency`, `totalCost`. Append-only rows make `pricingId` reproduce the math exactly.
- Parent cost = the winning attempt's cost (Phase 1 returns on first success, so exactly one success per request). Do not sum failed attempts; if an upstream billed a failed attempt we cannot see it — documented under-count.
- Unseeded models (all Anthropic/Gemini, plus any OpenAI model without a price row) log normally with full attempt rows and tokens; only `totalCost`/`pricingId`/`currency` stay `null`. **Cost coverage today is `gpt-4o-mini` only:** `prisma/seed.js` seeds three `Model` rows (`mock`, `gpt-4o-mini`, `claude-3-5-haiku-latest`), and Phase 1 seeds four prices but creates **no** `Model` row for `gpt-5-mini`, `gpt-5-nano`, `gpt-4.1-mini`.
- Numeric work never leaves `Prisma.Decimal` (§3.4). No cost is serialised over HTTP in Phase 1.

### 6.7 Stale PROCESSING cleanup

**Public `sweepStaleProcessing(olderThanMs = 15 min)` and `heartbeatInFlight()`, both invoked fire-and-forget from `onModuleInit`: the sweep every 5 minutes, the heartbeat every 30 seconds, each through `setInterval(...).unref()`.**

- `RequestLog.heartbeatAt` is the durable liveness signal. `start()` inserts it with the column default `now()`; `heartbeatInFlight()` refreshes every id this process still owns in one guarded `UPDATE`. Another instance's sweep reads the same row, so a live request is never abandoned because it lives in a different process.
- A crashed instance stops heartbeating. After 15 minutes without a beat the row is eligible; five heartbeat intervals fit inside that cutoff.
- Both stale cutoffs are computed by PostgreSQL (`now() - ($n::int * interval '1 millisecond')`). The application clock is never compared with a database timestamp, so instance clock skew cannot cause a false abandonment.
- A single provider attempt is capped at 5 minutes (`MAX_PROVIDER_TIMEOUT_MS` in `RouterService`), so one attempt always finishes well inside the lease.
- **`updateMany` cannot express this.** Prisma's `data` cannot reference another column, so `latencyMs = now - startedAt` is unrepresentable. Use parameterised raw SQL. The attempt-liveness guard (any attempt inside the window proves progress) and the local ownership guard remain; the local set is a batching registry and same-process fast path, not the distributed boundary:

```ts
const staleMs = Math.max(0, Math.trunc(olderThanMs));
const owned = [...this.inFlightRequestLogIds];
const ownershipGuard = owned.length === 0
  ? Prisma.empty
  : Prisma.sql`AND rl."id" NOT IN (${Prisma.join(owned)})`;

const rows = await this.prisma.$executeRaw(Prisma.sql`
  UPDATE "RequestLog" rl
     SET "status" = 'FAILED', "errorCode" = 'ABANDONED', "failureClass" = 'ABANDONED',
         "finishedAt" = now(),
         "latencyMs" = GREATEST(0, (EXTRACT(EPOCH FROM (now() - rl."startedAt")) * 1000)::int)
   WHERE rl."status" = 'PROCESSING'
     AND rl."heartbeatAt" < now() - (${staleMs}::int * interval '1 millisecond')
     AND NOT EXISTS (
       SELECT 1 FROM "RequestAttempt" ra
        WHERE ra."requestLogId" = rl."id"
          AND ra."createdAt" > now() - (${staleMs}::int * interval '1 millisecond')
     )
     ${ownershipGuard}
`);
```

`Prisma.sql`, `${staleMs}` and `Prisma.join(owned)` are bound parameters — never string interpolation. `GREATEST(0, ...)` clamps clock skew that would otherwise produce a negative `latencyMs`. The heartbeat update is guarded the same way (`WHERE "status" = 'PROCESSING' AND "id" IN (...)`), so a late beat cannot resurrect a row another instance already abandoned.

- **A raw-SQL failure is caught and reported to telemetry, never thrown**: `catch (error) { this.telemetry.logError({ traceId: 'sweep' | 'heartbeat', errorCode: 'REQUEST_LOG_WRITE_FAILED', errorMessage: sanitizeErrorMessage(error) ?? 'unknown', statusCode: 0 }); return 0; }`. Store both handles — `this.sweepTimer = setInterval(...); this.heartbeatTimer = setInterval(...)` — `unref()` them, and `clearInterval` both in `onModuleDestroy`, so a test that boots the module can shut it down.

### 6.8 Every write is wrapped

`RequestLogService` is the only writer. Each method: `try { prisma... } catch (error) { this.telemetry.logError({ traceId, errorCode: 'REQUEST_LOG_WRITE_FAILED', statusCode, errorMessage: sanitizeErrorMessage(...) ?? 'unknown' }); return null | void | false }`. `statusCode` is required by `telemetry.logError`; pass the request's real status when known and **`0`** when it failed before a response existed (the `start()` failure path and the sweep).

`GatewayService` wraps its calls again (`reportLoggingFailure`) because a fake or subclass may throw. The **same** helper wraps `CostCalculator.calculate` (§5.5), so a pricing/DB failure yields `totalCost: null`. Neither layer rethrows, so `return { ...result.response.response, trace_id }` is always reached — the existing `gateway-service.test.js` invariant.

### 6.9 Traceability

`traceId` is set by the Fastify `onRequest` hook (`app.setup.ts:15-23`), read by `@TraceId()`, copied to `RequestContext.traceId`, written to `RequestLog.traceId`, inherited by `RequestAttempt` via `requestLogId`, and returned as `trace_id` + `x-trace-id`. `requestId` comes from `x-request-id` (fallback traceId, `decorators/index.ts:17-25`). Self-serve retrieval (`GET /api/v1/requests/:traceId`, `where: { traceId, userId }`) is Phase 2 — no endpoint in Phase 1.

## 7. Ordered task list

Every task ends green. `npm test` runs `npm run build` first, and `node --test` runs the compiled `dist/`. **No task applies a migration**; the only gated step is Task 11.

| # | Task | Ends with |
|---|---|---|
| 0 | Baseline | `npm test` → 53 pass; `git status --porcelain` → `?? .opencode/`, `?? docs/` |
| 1 | `RequestContext` | 3 new tests; commit `feat: add shared request context for gateway lifecycle` |
| 2 | Error taxonomy, classifier, sanitizer | 6 new tests; commit `feat: add centralized error taxonomy and failure classifier` |
| 3 | Controller + resilience use the taxonomy | 53 pass; commit `refactor: derive provider error responses from the shared taxonomy` |
| 4 | Prisma schema + 2 compile fixes | `prisma generate` + typecheck + build; **no apply**; commit `feat: model request attempts and model pricing in prisma schema` |
| 5 | Migration SQL + V1–V4 | `prisma validate` + static checks; **no apply**; commit `feat: add requestlog foundation migration` |
| 6 | Pricing, `CostCalculator`, seed rows | 5 new tests; **no apply**; commit `feat: add model pricing and deterministic cost calculation` |
| 7 | `RequestLogService` (write-early/update-late) + `toAttemptRecord` | 6 new tests; commit `feat: add write-early request log service with guarded finalization` |
| 8 | Stale `PROCESSING` sweep | 2 more tests (8 total in the suite); commit `feat: sweep abandoned PROCESSING request logs` |
| 9 | Gateway attempt capture + module wiring + controller context | 8 new tests in `gateway-logging`; commit `feat: capture every provider attempt in the request log` |
| 10 | Caller-fault rows for rejected requests | 9th `gateway-logging` test; commit `feat: log rejected chat requests as caller faults` |
| 11 | **Migration approval checkpoint** (§4.4) | migration + seed applied, V5–V11 pass, smoke test; commit `chore: apply requestlog foundation migration` only if tracked files changed |
| 12 | Full verification + docs | 84 pass, typecheck, validate, `migrate status`; commit `docs: document requestlog foundation behaviour` |
| 13 | Traceability pass | `npm test` → 0 fail; commit only if changed |

**Task 1 — `RequestContext`.** Files: `src/common/context/request-context.ts`, `test/request-context.test.js`, `package.json`.
Tests first: `'derives the context from the authenticated user and request headers'`, `'falls back to unknown when the body has no model'`, `'records streaming intent without enabling streaming'`.
Implement §5.1 (no Nest imports). Verify `npm run build && node --test test/request-context.test.js`.

**Task 2 — Error taxonomy, classifier, sanitizer.** Files: `src/common/errors/error-taxonomy.ts`, `src/common/errors/failure-classifier.ts`, `test/error-taxonomy.test.js`, `package.json`.
Tests first: `'maps every provider error code to its failure class and HTTP status'`, `'reproduces the full error envelope for every provider code and caller rejection'`, `'classifies validation and unsupported features as caller faults without dropping param'`, `'classifies unexpected errors as internal without leaking messages'`, `'redacts secrets and truncates long error messages'`, `'keeps provider wire codes unchanged'`.
The second test is the §6.4 proof: for each of the six provider codes, assert `getResponse()` equals `{ code, message, statusCode }` exactly (no `param` key); for `UNSUPPORTED_FEATURE`/`VALIDATION_ERROR`, assert `{ code, message, param, statusCode }` with `param` equal to what was thrown. Implement §5.2/§5.3; strings must match §6.4 character-for-character; `classifyException` order = `ProviderError` → `HttpException` (read `getResponse().code`) → `Error` → `INTERNAL`/`Internal server error`.

**Task 3 — Controller and retry policy through the taxonomy.** Files: `src/modules/gateway/gateway.controller.ts` (`mapProviderError` body only), `src/modules/providers/resilience.service.ts` (local set → `isRetryableProviderCode`; leave the `PROVIDER_BAD_REQUEST` throw-fast branch untouched, §10).
No new test; regression signal is every existing suite, including `error-contract`'s status/code assertions and `chat-contract`'s `param` assertions. Verify `npm test` (53 pass).

**Task 4 — Prisma schema + compile fixes.** Files: `prisma/schema.prisma`, `src/modules/gateway/gateway.service.ts` (`cost: null` → `totalCost: null`), `src/modules/spend/spend.module.ts` (`_sum.cost` → `_sum.totalCost` ×2).
Implement §3: enums one value per line, extended `RequestLog`, `RequestAttempt`, `ModelPricing`, `User.modelPricing`, indexes. `insights.service.ts` is not touched (§3.1). No unit test; the failing signal is `tsc`. Verify `npx prisma validate && npx prisma generate && npm run typecheck && npm run build`. **No migration is applied and the app is not started against Neon.**

**Task 5 — Migration SQL (generate + hand-edit + static checks).** File: `prisma/migrations/20261102090000_requestlog_foundation/migration.sql`.
§4.1 Path B, then every §4.2 edit, then §4.3 **V1–V4**. No FK before its table exists; `status` added nullable with no default, backfilled, then `SET NOT NULL` + `SET DEFAULT 'PROCESSING'`. Verify `npx prisma validate` + V1–V4. **Nothing is applied.**

**Task 6 — Pricing, cost calculator, seed rows.** Files: `src/modules/pricing/{pricing.module,pricing.service,cost-calculator}.ts`, `prisma/seed.js`, `test/cost-calculator.test.js`, `package.json`.
Tests first: `'prices a known usage at ten decimal places'` (asserts `"0.00045"` for 1000 prompt + 500 completion on `gpt-4o-mini`), `'returns null when pricing is unknown'`, `'returns null cost when usage is missing'`, `'charges zero for zero tokens'` (asserts `"0"`), `'returns null instead of throwing when the pricing lookup fails'`.
Seed only verified USD/M rows, `effectiveFrom: new Date('2026-01-01T00:00:00.000Z')`, `provider: 'openai'`, prices as **strings** so Prisma keeps Decimal precision, `findFirst`-then-create, log `Seeded N model prices`:

| model | in | out | | model | in | out |
|---|---|---|---|---|---|---|
| `gpt-4o-mini` | `0.15` | `0.60` | | `gpt-5-nano` | `0.05` | `0.40` |
| `gpt-5-mini` | `0.25` | `2.00` | | `gpt-4.1-mini` | `0.40` | `1.60` |

Do **not** seed Anthropic/Gemini (unverified). Do **not** add `Model` rows for the three new OpenAI models — so only `gpt-4o-mini` is priced today (§6.6). Verify `npm run build && node --test test/cost-calculator.test.js`. **No apply.**

**Task 7 — `RequestLogService` + `toAttemptRecord`.** Files: `src/common/observability/attempt-observation.ts`, `src/modules/logging/{request-log.types,request-log.service,request-log.module}.ts`, `test/request-log-service.test.js`, `package.json`.
Tests first: `'start writes a PROCESSING row with the known context fields'`, `'toAttemptRecord derives the latency split once and overheadMs is never negative'`, `'appendAttempt persists overheadMs verbatim and sanitizes errors'`, `'finalizeSuccess is guarded by PROCESSING status'`, `'finalizeFailure stores the last failure class and wire code'`, `'a failed write is swallowed and reported to telemetry'`.
Implement §5.6–§5.9. `AttemptObservation` lives in `src/common/observability/`, **not** in the logging module. `RequestLogModule` declares `imports: [TelemetryModule]`. Finalize uses `updateMany({ where: { id, status: 'PROCESSING' }, data })` and returns `count === 1`; `appendAttempt` maps `P2002` to a debug log + return. `onModuleInit`/`onModuleDestroy` are stubs until Task 8.

**Task 8 — Stale PROCESSING sweep.** Files: `request-log.service.ts` (`onModuleInit`, `onModuleDestroy`, `sweepStaleProcessing`), `test/request-log-service.test.js` (extend).
Tests first: `'sweepStaleProcessing marks expired PROCESSING rows abandoned'` (asserts the SQL text, the bound cutoff, and the `FAILED`/`ABANDONED`/`ABANDONED` payload), `'a failed sweep is reported to telemetry and never thrown'`.
Implement §6.7 with `prisma.$executeRaw(Prisma.sql\`...\`)` — **not** `updateMany`. Store the interval handle, `unref()` it, clear it in `onModuleDestroy`.

**Task 9 — Gateway attempt capture, finalization, module wiring, controller context.** Files: `resilience.service.ts` (`onAttempt`, indexed loop), `base.provider.ts` (`ProviderOptions.context?`), `gateway.service.ts` (rewrite `createCompletion`; delete `recordSuccessfulRequest` and the private `RequestContext`), `gateway.controller.ts` (**context construction + call site only**; keep the 4-argument signature), `gateway.module.ts` (+`PricingModule`, `RequestLogModule`), `app.module.ts` (+both), `test/gateway-logging.test.js`, `test/gateway-service.test.js` (rewire only), `package.json`.
Tests first (8): `'records one SUCCEEDED attempt for a single-target success'`, `'records two attempts on the same target when a retry succeeds'`, `'marks fallbackUsed when the primary fails and the fallback serves'`, `'finalizes FAILED with the last failure when every target fails'`, `'returns the provider response when the request log write fails'`, `'stores the pricing snapshot so totalCost reproduces the arithmetic'`, `'records null cost for an unknown price and still returns the response'`, `'returns the provider response when the pricing lookup throws'`.
Implement §6.2/§6.3/§6.6/§6.8: `start` → route → `execute` with the `onAttempt` closure from §6.2 (pushes into `pendingWrites`, never awaits inline) → `await Promise.allSettled(pendingWrites)` → cost inside `reportLoggingFailure` → `finalizeSuccess`; on throw classify → `await Promise.allSettled(pendingWrites)` → `finalizeFailure` → `telemetry.logError` → rethrow.

**The controller change belongs here, not in Task 10.** Changing `createCompletion`'s parameter type to `RequestContext` breaks the existing call site `{ user, traceId, requestId }`; the controller must build the context in the same commit or the build fails. Task 10 adds only the validation catch and `recordRejectedRequest`.

**Module wiring belongs to this commit**: the constructor gains `RequestLogService` and `CostCalculator` here, so `GatewayModule` must import `RequestLogModule` + `PricingModule` in the same commit or `nest start` cannot boot.

`test/gateway-service.test.js` needs **three fakes** it does not have today — the existing telemetry fake only implements `logRequest`, so it must gain `logError`; `PrismaService` is replaced by a `RequestLogService` fake (`start`, `appendAttempt`, `finalizeSuccess`, `finalizeFailure`); and a `CostCalculator` fake (`calculate`). Keep **both existing test names** and the "persistence failure does not fail the request" invariant; assert on the fakes (`started[0].requestId === 'request-1'`, `finalized[0].totalTokens === 5`, one `logRequest`, one `logger.error` containing `trace-1`). No test deleted; total stays 53 before new suites.

**Task 10 — Caller-fault rows for rejected requests.** Files: `gateway.service.ts` (`recordRejectedRequest`), `gateway.controller.ts` (validation catch only), `test/gateway-logging.test.js` (extend).
Test first: `'records a FAILED caller-fault row for a rejected request with no attempts'`.
`recordRejectedRequest(context, input)` = `start` + `finalizeFailure({ statusCode: 400, failureClass: 'CALLER_FAULT', errorCode: input.code, errorMessage: sanitizeErrorMessage(input.message), attemptCount: 0, fallbackUsed: false, latencyMs: 0 })`, fully wrapped; the controller calls it optionally and rethrows the identical `HttpException`.

**Task 11 — Migration approval checkpoint (gated).** Nothing runs without explicit approval at this point.
Execute §4.4 steps 1–9 in one window: baselines → `migrate deploy` → `generate` → `db seed` → **V5–V11** → deploy build → smoke test → resume. If V5–V11 fail, stop and roll back (§4.5); do not resume traffic.

**Task 12 — Full verification and docs.** Files: `docs/` only; no source change expected.
`npm test` (expect **84** passing, 0 failing), `npm run typecheck`, `npx prisma validate`, `npx prisma migrate status`; confirm `.env.example` needs **no** change (Phase 1 adds no env var); `git status --porcelain` lists only intended files.

**Task 13 — Traceability pass.** Re-check §8.3 against the suites; add a missing case only if one is absent. `npm test` → 0 fail.

## 8. Test plan

### 8.1 Preserve

All 8 suites and 53 cases: `config` 10, `chat-contract` 8, `error-contract` 6, `gateway-service` 2, `resilience` 13, `credential-manager` 5, `provider-normalization` 5, `provider-http` 4. Six suites are **not edited at all**; `resilience` is not edited; `gateway-service` is rewired per Task 9 with both test names and intent preserved.

Invariants that must stay literally true: `error-contract` provider codes → `[504,429,400,502,503,502]` with wire `code` = provider code, `trace_id` passthrough, `Error` → 500 `Internal server error`, unexpected errors rethrown untouched; `chat-contract` `UNSUPPORTED_FEATURE`/`VALIDATION_ERROR` cases **including `param`**; `gateway-service` success returned when persistence throws with one reported error; the controller keeps its 4-argument signature.

### 8.2 Add

| File | Cases | Focus |
|---|---|---|
| `test/request-context.test.js` | 3 | factory, model fallback, `isStream` |
| `test/error-taxonomy.test.js` | 6 | §6.4 table, **full envelope incl. `param`**, sanitization, wire-code stability |
| `test/cost-calculator.test.js` | 5 | known/unknown pricing, missing usage, zero, 10-dp rounding, throwing lookup |
| `test/request-log-service.test.js` | 8 | start, latency split, append, guarded finalize ×2, swallowed write, sweep marks, sweep failure |
| `test/gateway-logging.test.js` | 9 | the scenarios below |
| **Total new** | **31** | 53 existing + 31 = **84** |

### 8.3 End-to-end scenarios (fake `RequestLogService`; real or fake `ResilienceService`)

| # | Scenario | Parent | Attempts |
|---|---|---|---|
| 1 | success, 1 target, 1 attempt | `SUCCESS`, `attemptCount=1`, `fallbackUsed=false`, `statusCode=200`, tokens + `totalCost` + `pricingId` set | 1 × `SUCCEEDED`, `attemptIndex=0`, `isFallback=false`, `upstreamLatencyMs` set, `overheadMs = latencyMs - upstreamLatencyMs` (≥ 0) |
| 2 | retry then success | `SUCCESS`, `attemptCount=2`, `fallbackUsed=false` | #0 `FAILED`/`TIMEOUT`, #1 `SUCCEEDED`; both `isFallback=false`, `attemptOnTarget` 0/1 |
| 3 | primary fails, fallback succeeds | `SUCCESS`, `attemptCount=2`, `fallbackUsed=true`, `servedModel` = fallback upstream | #0 `FAILED` `isFallback=false`, #1 `SUCCEEDED` `isFallback=true` |
| 4 | every target fails | `FAILED`, `errorCode`/`failureClass` = last failure, sanitized message, mapped `statusCode` | one `FAILED` per attempt, class populated |
| 5 | validation 400 (`stream: true`) | `FAILED`, `CALLER_FAULT`, `UNSUPPORTED_FEATURE`, `statusCode=400`, `attemptCount=0` | **none** |
| 6 | pricing known vs unknown | `"0.00045"` for 1000+500 on `gpt-4o-mini`; unknown price → exactly `null` (never `0`), `pricingId=null`, `currency=null` | same rule on the attempt |
| 7 | log write fails at every step | provider response unchanged, `logError` with `REQUEST_LOG_WRITE_FAILED`, no throw | none persisted |
| 8 | pricing lookup throws (post-success path) | **request still succeeds**, `200` + body, `totalCost=null`, `pricingId=null` | attempt written with `totalCost=null` |
| 9 | stale sweep | only `PROCESSING` rows older than 15 min → `FAILED`/`ABANDONED`/`ABANDONED` | untouched |

Scenarios 1–4, 6–8 land in `gateway-logging` (Task 9, 8 cases); scenario 5 is its 9th case (Task 10); scenario 9 lives in `request-log-service` (Task 8). All tests use in-memory fakes; `npm test` must run offline.

### 8.4 `package.json` `test` script (exact)

```json
"test": "npm run build && node --test test/config.test.js test/chat-contract.test.js test/error-contract.test.js test/gateway-service.test.js test/resilience.test.js test/credential-manager.test.js test/provider-normalization.test.js test/provider-http.test.js test/request-context.test.js test/error-taxonomy.test.js test/cost-calculator.test.js test/request-log-service.test.js test/gateway-logging.test.js"
```

Add each file in the task that creates it so every commit is green. Final expected: **84 passing (53 existing + 31 new), 0 failing**.

## 9. Risks & failure scenarios

| Risk | Trigger | Mitigation |
|---|---|---|
| Double finalize | retry, duplicate event, sweep racing the handler | `updateMany({ where: { id, status: 'PROCESSING' } })`, `count === 0` → `false`; sweep uses the same guard |
| Orphan attempts | parent deleted, or `logId` null | FK `onDelete: Cascade`; skip attempt writes when `start` returned null |
| Partial write | process killed between attempts and finalize | parent stays `PROCESSING` → sweep marks `ABANDONED`; attempts already on disk remain readable |
| **Schema ahead of code** | migration applied before Task 9/10 land | migration is Task 11; Tasks 4–10 never touch Neon; app must not boot against Neon until then (§4.4) |
| **Code ahead of schema** | app started against Neon between Tasks 4–10 | log writes reference missing columns → swallowed, so requests succeed but nothing is recorded; forbidden by §4.4 |
| Decimal loss | `Prisma.Decimal` → `Number` in a DTO | costs are `Decimal` in the database only; Phase 1 serialises no cost |
| PROCESSING inflates dashboards | new status, existing queries | Phase 1 leaves every endpoint byte-identical. Phase 4 queries must filter `status: { not: 'PROCESSING' }` |
| Pricing failure breaks a paid request | `CostCalculator`/Prisma throws after the provider answered | `calculate()` is total **and** runs inside `reportLoggingFailure`; scenario 8 asserts a successful response with `totalCost=null` |
| Sweep crashes the process | raw SQL throws on a timer with no handler | catch → `telemetry.logError({ ..., statusCode: 0 })` → `return 0`; interval `unref()`-ed and cleared |
| Added latency | `start` awaits Neon; finalize awaits | only `start` is on the critical path; `upstreamLatencyMs` vs `latencyMs` makes overhead measurable from day one; if p95 overhead > 20 ms, defer `start` and accept losing earliest failures |
| Neon cold start / pooling | suspended compute, many connections | pooled `DATABASE_URL` (`-pooler` host) + `?sslmode=require&pgbouncer=true&connection_limit=1` |
| Pricing drift | docs change, seed re-run | append-only rows with `effectiveFrom`; seed never updates; `pricingId` reproduces the math |
| Cost silently zero | `?? 0` in the cost path | `null` is the only unknown; scenario 6 asserts `strictEqual(totalCost, null)` |
| Secrets in error text | provider echoes the key | sanitize every persisted message; never store provider bodies |
| Classifier drops `param` | rebuild path forgets it | §6.4 `param` column + Task 2 full-envelope test; `chat-contract` would fail otherwise |

## 10. Non-goals & what Phase 2 needs

**Non-goals (Phase 1):** BYOK / `ProviderCredential` / credential encryption and `credentialId` FKs; model ownership changes and team/org scoping; admin pricing API, price import, currency conversion; **any change to an existing HTTP response** — `/insights/me`, `/admin/insights`, `/spend/*` and `/models` keep their current payloads byte-identical, and analytics land in **Phase 4**; governance (quotas, per-key limits, spend caps); streaming/SSE and `timeToFirstTokenMs` population; content logging (`LOG_CONTENT` is **not added to `env.ts` or `.env.example`** in Phase 1); Anthropic/Gemini pricing or token counting for providers that omit `usage`; `Model` rows for `gpt-5-mini`, `gpt-5-nano`, `gpt-4.1-mini`; `retryAfterMs` parsing.

**Known, accepted, out of scope:** `logging.interceptor.ts` keeps reading `request.provider` / `request.model`, which nothing sets — they stay `undefined`. `resilience.service.ts` keeps its second, narrower retry-policy copy (the `PROVIDER_BAD_REQUEST` throw-fast branch); only `RETRYABLE_CODES` (four members) is replaced by `isRetryableProviderCode`. Three of the four seeded prices are inert until their `Model` rows exist (§6.6).

**Phase 2 needs from Phase 1:** (1) `credentialId` columns + `RequestContext.apiKeyId`; (2) `ModelPricing` user scope + effective dating + `PricingService.resolvePricing`; (3) parent `status`/`failureClass`/requested-vs-served model/`attemptCount`/`fallbackUsed`; (4) `RequestAttempt` latency split, `isFallback`, `attemptOnTarget`, `providerStatus`, `providerRequestId`; (5) `traceId` + `(userId, createdAt)` for self-serve lookup; (6) reserved streaming columns so streaming is a write, not a migration.

## Approval

- [ ] **Migration strategy** — `20261102090000_requestlog_foundation` generated with `prisma migrate diff --from-schema-datasource` (no Neon shadow DB), hand-edited for the `cost → totalCost` rename + the `errorCode`-based backfill, verified by §4.3 V1–V4 statically and V5–V11 in the window.
- [ ] **Migration timing** — applied in **Task 11**, after Tasks 1–10 (all Phase 1 code) exist, in one maintenance window with the code deploy. Never at the end of Task 6.
- [ ] **Pricing seed** — only the four verified OpenAI rows in USD per 1M tokens; Anthropic and Gemini unseeded, cost stays `null`; no `Model` row for the three new OpenAI ids, so only `gpt-4o-mini` is priced today.
- [ ] **Execution mode** — subagent-driven (one task per subagent, review between tasks) **or** inline execution in this session.
