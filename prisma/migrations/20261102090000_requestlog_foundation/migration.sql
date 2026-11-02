-- Request log foundation: lifecycle status, attempts, model pricing.
--
-- Generated without a shadow database (Neon cannot create one: P3014), then
-- hand-edited. Two edits matter:
--   1. "cost" is RENAMED to "totalCost" and retyped, never dropped and re-added.
--   2. "status" is added NULLABLE with no default, backfilled from "errorCode",
--      and only then made NOT NULL with DEFAULT 'PROCESSING'.
-- Existing rows get "attemptCount" = 0: attempt tracking did not exist before
-- this migration, so legacy rows are known-incomplete by construction.
-- Do not apply this while the application is writing rows (plan section 4.4).

-- 1. Enums

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PROCESSING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "FailureClass" AS ENUM ('CALLER_FAULT', 'AUTH_FAULT', 'RATE_LIMIT', 'TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_ERROR', 'CONFIGURATION', 'INTERNAL', 'ABANDONED');

-- 2. ModelPricing (no foreign key yet: "User" exists, but keep every FK at the end)

-- CreateTable
CREATE TABLE "ModelPricing" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "userId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "inputPricePerMillion" DECIMAL(18,8) NOT NULL,
    "outputPricePerMillion" DECIMAL(18,8) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelPricing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Postgres treats NULLs as distinct in a composite unique, so global rows
-- ("userId" IS NULL) can be duplicated. Phase 1 enforces uniqueness in the
-- seed; Phase 2 adds a partial unique index in its own migration.
CREATE UNIQUE INDEX "ModelPricing_provider_model_userId_effectiveFrom_key" ON "ModelPricing"("provider", "model", "userId", "effectiveFrom");

-- 3. RequestAttempt (columns only, no foreign key yet)

-- CreateTable
CREATE TABLE "RequestAttempt" (
    "id" TEXT NOT NULL,
    "requestLogId" TEXT NOT NULL,
    "attemptIndex" INTEGER NOT NULL,
    "attemptOnTarget" INTEGER NOT NULL DEFAULT 0,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "servedModel" TEXT,
    "credentialId" TEXT,
    "status" "AttemptStatus" NOT NULL,
    "isStream" BOOLEAN NOT NULL DEFAULT false,
    "providerStatus" INTEGER,
    "failureClass" "FailureClass",
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryAfterMs" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "upstreamLatencyMs" INTEGER,
    "overheadMs" INTEGER,
    "timeToFirstTokenMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "pricingId" TEXT,
    "inputCost" DECIMAL(18,10),
    "outputCost" DECIMAL(18,10),
    "totalCost" DECIMAL(18,10),
    "providerRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestAttempt_pkey" PRIMARY KEY ("id")
);

-- 4. RequestLog: add the new columns.
-- "status" is NULLABLE and has no DEFAULT on purpose: it is backfilled below,
-- then made NOT NULL with its real default 'PROCESSING'.

-- AlterTable
ALTER TABLE "RequestLog"
  ADD COLUMN     "requestedModel" TEXT,
  ADD COLUMN     "servedModel" TEXT,
  ADD COLUMN     "status" "RequestStatus",
  ADD COLUMN     "failureClass" "FailureClass",
  ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN     "credentialId" TEXT,
  ADD COLUMN     "isStream" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN     "currency" TEXT,
  ADD COLUMN     "startedAt" TIMESTAMP(3),
  ADD COLUMN     "finishedAt" TIMESTAMP(3),
  ADD COLUMN     "pricingId" TEXT;

-- 5. Backfill every existing row. There is no "success" column: the only writer
-- today inserts "errorCode" = NULL on success and nothing at all on failure,
-- so the status is derived from "errorCode". "statusCode" is left untouched.

-- Backfill requestedModel from the joined Model alias
UPDATE "RequestLog" rl
SET "requestedModel" = COALESCE(m."name", 'unknown')
FROM "Model" m
WHERE m."id" = rl."modelId";

-- Backfill requestedModel for rows with no model (or a dangling modelId)
UPDATE "RequestLog"
SET "requestedModel" = 'unknown'
WHERE "requestedModel" IS NULL;

-- Backfill status / startedAt / finishedAt / attemptCount / fallbackUsed
UPDATE "RequestLog"
SET "status"       = CASE WHEN "errorCode" IS NULL THEN 'SUCCESS'::"RequestStatus"
                          ELSE 'FAILED'::"RequestStatus" END,
    "startedAt"    = "createdAt",
    "finishedAt"   = "createdAt",
    "attemptCount" = 0,
    "fallbackUsed" = false;

-- 6. Now that every row has a value, tighten the columns

-- AlterTable
ALTER TABLE "RequestLog"
  ALTER COLUMN "requestedModel" SET NOT NULL,
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'PROCESSING',
  ALTER COLUMN "startedAt" SET NOT NULL,
  ALTER COLUMN "startedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- 7. Rename "cost" instead of dropping and re-adding it, then widen the type.
-- Every existing value is NULL (the only writer hardcodes it), so the cast
-- cannot fail.

-- AlterTable
ALTER TABLE "RequestLog" RENAME COLUMN "cost" TO "totalCost";

-- AlterTable
ALTER TABLE "RequestLog" ALTER COLUMN "totalCost" TYPE DECIMAL(18,10) USING "totalCost"::numeric(18,10);

-- 8. Indexes

-- CreateIndex
CREATE INDEX "ModelPricing_provider_model_isActive_effectiveFrom_idx" ON "ModelPricing"("provider", "model", "isActive", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ModelPricing_userId_idx" ON "ModelPricing"("userId");

-- CreateIndex
CREATE INDEX "ModelPricing_model_idx" ON "ModelPricing"("model");

-- CreateIndex
CREATE INDEX "RequestAttempt_requestLogId_idx" ON "RequestAttempt"("requestLogId");

-- CreateIndex
CREATE INDEX "RequestAttempt_provider_createdAt_idx" ON "RequestAttempt"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "RequestAttempt_failureClass_createdAt_idx" ON "RequestAttempt"("failureClass", "createdAt");

-- CreateIndex
CREATE INDEX "RequestAttempt_pricingId_idx" ON "RequestAttempt"("pricingId");

-- CreateIndex
CREATE UNIQUE INDEX "RequestAttempt_requestLogId_attemptIndex_key" ON "RequestAttempt"("requestLogId", "attemptIndex");

-- DropIndex
-- ("userId") is replaced by the composite ("userId", "createdAt") below.
DROP INDEX "RequestLog_userId_idx";

-- CreateIndex
CREATE INDEX "RequestLog_userId_createdAt_idx" ON "RequestLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_provider_createdAt_idx" ON "RequestLog"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_status_startedAt_idx" ON "RequestLog"("status", "startedAt");

-- CreateIndex
CREATE INDEX "RequestLog_failureClass_createdAt_idx" ON "RequestLog"("failureClass", "createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_pricingId_idx" ON "RequestLog"("pricingId");

-- 9. Foreign keys last: every referenced table now exists.

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_pricingId_fkey" FOREIGN KEY ("pricingId") REFERENCES "ModelPricing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestAttempt" ADD CONSTRAINT "RequestAttempt_requestLogId_fkey" FOREIGN KEY ("requestLogId") REFERENCES "RequestLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestAttempt" ADD CONSTRAINT "RequestAttempt_pricingId_fkey" FOREIGN KEY ("pricingId") REFERENCES "ModelPricing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelPricing" ADD CONSTRAINT "ModelPricing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
