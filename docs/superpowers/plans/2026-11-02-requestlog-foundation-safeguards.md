# Safeguards addendum - binding deltas to revision 2

Applies to Tasks 0-10. Where this addendum and the revision-2 plan disagree, **this addendum wins**.
It encodes the three safeguards the user required before execution started.

## S1 - Logging failure never breaks a successful response, but is always observable

`reportLoggingFailure(scope, error, traceId)` in `GatewayService` is the single wrapper around every
logging and pricing call:

```ts
private reportLoggingFailure(scope: string, error: unknown, traceId: string): void {
  this.telemetry.logError({
    traceId,
    errorCode: 'REQUEST_LOG_WRITE_FAILED',
    errorMessage: `${scope}: ${sanitizeErrorMessage(error) ?? 'unknown'}`,
    statusCode: 0,
  });
}
```

Rules:
- The provider response is returned even when logging fails: every call is
  `try { ... } catch (e) { this.reportLoggingFailure(scope, e, traceId); }`.
- `CostCalculator.calculate()` is total (returns `null`) and `RequestLogService` swallows its own
  writes, so the wrapper is defence in depth, not the only guard.
- Observable signal is **both**: `TelemetryService.logError` (emits `error.logged`) and a `Logger.error`
  line carrying `traceId`. A silent `catch {}` is a defect.
- Test evidence: scenario 7 (log write fails at every step -> response unchanged + `logError` with
  `REQUEST_LOG_WRITE_FAILED`) and scenario 8 (pricing lookup throws -> `200` + `totalCost: null`).

## S2 - Rollback covers database schema **and** application compatibility

Forward-only migration; the rollback must restore both halves in a compatible order.

Rollback sequence (reverse of the apply window, single instance, traffic stopped):

1. Stop traffic and stop the Phase 1 process.
2. Redeploy the **previous** build (`56112fc`) - it writes `cost` and knows nothing about
   `RequestAttempt` or `totalCost` - but do **not** start it yet.
3. Run the inverse SQL in dependency order. **Foreign keys are dropped FIRST** - dropping a table
   before the FK that references it fails with `2BP01` and leaves the schema half-reverted:
   a. drop the four foreign keys: `RequestLog_pricingId_fkey`,
      `RequestAttempt_requestLogId_fkey`, `RequestAttempt_pricingId_fkey`,
      `ModelPricing_userId_fkey`;
   b. drop `RequestAttempt`, then `ModelPricing`;
   c. drop the new indexes;
   d. drop the added `RequestLog` columns;
   e. `ALTER COLUMN "totalCost" TYPE DOUBLE PRECISION`, then `RENAME COLUMN "totalCost" TO "cost"`;
   f. drop the three enum types.
4. `npx prisma generate` against the reverted schema, then start the previous build.
5. Smoke test: one `mock` completion succeeds and writes a `cost` row (`null`).

Ordering is load-bearing in both directions:
- **Forward:** old code + new schema = log writes fail (swallowed) -> the gateway looks healthy while
  recording nothing. Hence schema and code ship in one window (Task 11).
- **Rollback:** new code + old schema = boot/type errors; old code + new schema = silent write loss.
  Hence step 2 stops the new build before step 3, and the old build starts only after step 4.
- `cost` is always `null` today, so the rename/retype loses no data. Attempt rows and computed costs
  are lost on rollback - documented and accepted.

## S3 - The stale sweep must never abandon an actively executing request

Revision 2 sweeps on `startedAt < cutoff` only. That can abandon a request that is still running: a
request started 16 minutes ago, retrying or streaming, would be marked `FAILED`/`ABANDONED` while
still alive. A process-local set cannot fix this: another instance's sweeper cannot see it.

The durable fix is `RequestLog.heartbeatAt` (`20261102120000_requestlog_heartbeat_liveness`). Every
instance refreshes the heartbeat of the requests it owns every 30 seconds, and the sweep compares it
with PostgreSQL's clock:

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

Rationale:
- The database clock decides both cutoffs. Instances may have skewed clocks, and the heartbeat was
  written by whichever instance owns the request.
- A live request on any instance keeps refreshing its heartbeat, so another instance's sweep sees it as
  alive even before the first attempt row exists.
- A crashed instance stops refreshing. After 15 minutes without a beat its rows become eligible; five
  heartbeats fit inside the cutoff, so one slow heartbeat does not abandon a live request.
- `inFlightRequestLogIds` remains only a batching registry for heartbeats and a same-process fast
  path. It is not the distributed correctness boundary.
- The attempt-liveness guard remains as extra evidence of progress between heartbeats.
- A single provider attempt is capped at 5 minutes (`MAX_PROVIDER_TIMEOUT_MS`), well inside the lease.

Additional invariants:
- The sweep only touches `status = 'PROCESSING'`; finalized rows are never rewritten.
- `finalizeSuccess` / `finalizeFailure` keep `where: { id, status: 'PROCESSING' }`, so a finalize
  that races the sweep returns `false` instead of resurrecting an `ABANDONED` row.
- `heartbeatInFlight` is also guarded by `status = 'PROCESSING'`: a late beat cannot resurrect a row
  another instance already abandoned.
- If the owning process dies, its heartbeat expires and any instance reclaims the row.

Required concurrency/liveness tests:
1. `sweepStaleProcessing marks expired PROCESSING rows abandoned`
2. `sweepStaleProcessing skips a stale row that produced an attempt inside the cutoff`
3. `sweepStaleProcessing ignores rows that already left PROCESSING`
4. `two concurrent sweeps abandon a row exactly once`
5. `a sweep racing finalizeSuccess never overwrites the finalized row`
6. `a failed sweep is reported to telemetry and never thrown`
7. `two instances sharing a database never abandon the other instance's active request`
8. `a crashed instance's request becomes recoverable once its heartbeat expires`
9. `heartbeatInFlight touches only PROCESSING rows this instance owns`
10. `a sweep uses the database clock, not the application clock`

Tests use a fake `$executeRaw` that applies the predicate and status guard atomically and returns the
affected count. The multi-instance suite shares one fake `prisma` object and one virtual database clock
between two service instances, so the concurrency claim is exercised without a live database.

## S4 - Revised test counts

| Suite | Revision 2 | Addendum |
|---|---|---|
| `request-log-service` | 8 | **12** (6 from Task 7 + 6 from Task 8) |
| **New total** | 31 | **35** |
| **Grand total** | 84 | **88** (53 existing + 35 new) |

Task 8 therefore produces **6** new cases (the two revision-2 cases plus the four guard/caseness
cases); Task 10's `gateway-logging` suite stays at 9.