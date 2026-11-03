-- Request log liveness: a durable heartbeat shared by every instance.
--
-- The stale sweep used to compare startedAt, which cannot distinguish a
-- crashed request from one that is still executing on another instance before
-- its first attempt row exists. heartbeatAt is refreshed in the database while
-- the request runs, so the sweep can use a database-clock cutoff that is
-- correct across processes.
--
-- Additive only: the already-rehearsed requestlog_foundation migration is not
-- touched. Existing PROCESSING rows were started before this column existed, so
-- startedAt is the only liveness evidence they have; backfill from it.

-- 1. Add the column NULLABLE, with no default, so the backfill below supplies
--    every existing value.
ALTER TABLE "RequestLog" ADD COLUMN "heartbeatAt" TIMESTAMP(3);

-- 2. Backfill: a row that has not heartbeated yet is treated as last alive when
--    it started. A row that was already stale keeps its original cutoff.
UPDATE "RequestLog"
SET "heartbeatAt" = "startedAt"
WHERE "heartbeatAt" IS NULL;

-- 3. Tighten only after every row has a value.
ALTER TABLE "RequestLog"
  ALTER COLUMN "heartbeatAt" SET NOT NULL,
  ALTER COLUMN "heartbeatAt" SET DEFAULT CURRENT_TIMESTAMP;

-- 4. The sweep predicate is status + heartbeat cutoff.
CREATE INDEX "RequestLog_status_heartbeatAt_idx" ON "RequestLog"("status", "heartbeatAt");
