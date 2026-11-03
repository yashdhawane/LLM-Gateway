const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RequestLogService,
} = require('../dist/modules/logging/request-log.service.js');

// Multi-instance liveness. The fake below is a *shared* database: two service
// instances receive the same `prisma` object, exactly like two Node processes
// pointing at one PostgreSQL database. The clock is virtual and belongs to the
// database, so a heartbeat/expiry test never waits on wall time.

const MINUTE = 60 * 1000;

function fakeTelemetry() {
  const errors = [];

  return {
    errors,
    logError: (event) => {
      errors.push(event);
    },
    logRequest: () => {},
  };
}

function startInput(startedAt, overrides = {}) {
  return {
    traceId: 'trace-1',
    requestId: 'request-1',
    userId: 'user-1',
    apiKeyId: 'key-1',
    requestedModel: 'gpt-4o-mini',
    isStream: false,
    startedAt,
    ...overrides,
  };
}

function successInput(requestLogId, finishedAt, overrides = {}) {
  return {
    requestLogId,
    statusCode: 200,
    modelId: 'model-1',
    requestedModel: 'gpt-4o-mini',
    servedModel: 'gpt-4o-mini-2024-07-18',
    provider: 'openai',
    attemptCount: 1,
    fallbackUsed: false,
    currency: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    pricingId: null,
    totalCost: null,
    latencyMs: 10,
    finishedAt,
    ...overrides,
  };
}

function yieldTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * One database shared by every service instance created against it.
 *
 * `state.now` is the database clock: `now()` in the service SQL maps to it.
 * The sweep applies the same predicates as the real statement (status guard,
 * heartbeat cutoff, attempt-liveness guard, optional local ownership).
 */
function sharedDatabase({ now = new Date('2026-11-02T10:00:00.000Z') } = {}) {
  const state = {
    now: new Date(now.getTime()),
    rows: [],
    attempts: [],
    heartbeatQueries: 0,
    sweeps: 0,
    abandonWrites: 0,
    sweepInFlight: 0,
    peakSweepInFlight: 0,
    sweepQueries: [],
    throwOnHeartbeat: null,
  };

  const nowDate = () => new Date(state.now.getTime());

  function advance(ms) {
    state.now = new Date(state.now.getTime() + ms);
  }

  function addRow({ id, startedAt, heartbeatAt, status = 'PROCESSING' }) {
    const row = {
      id,
      status,
      statusCode: 0,
      startedAt: new Date(startedAt.getTime()),
      heartbeatAt: new Date(heartbeatAt.getTime()),
      finishedAt: null,
      latencyMs: null,
      errorCode: null,
      failureClass: null,
    };

    state.rows.push(row);
    return row;
  }

  const prisma = {
    $executeRaw: async (query) => {
      // Heartbeat: `UPDATE "RequestLog" SET "heartbeatAt" = now() ...`.
      if (/SET\s+"heartbeatAt"\s*=\s*now\(\)/.test(query.sql)) {
        state.heartbeatQueries += 1;

        if (state.throwOnHeartbeat) {
          throw state.throwOnHeartbeat;
        }

        await yieldTurn();

        const ids = new Set(
          query.values.filter((value) => typeof value === 'string'),
        );
        let affected = 0;

        for (const row of state.rows) {
          if (row.status !== 'PROCESSING') continue;
          if (!ids.has(row.id)) continue;

          row.heartbeatAt = nowDate();
          affected += 1;
        }

        return affected;
      }

      // Sweep: `UPDATE "RequestLog" SET "status" = 'FAILED' ...`.
      assert.match(query.sql, /SET\s+"status"\s*=\s*'FAILED'/);

      state.sweeps += 1;
      state.sweepQueries.push(query);
      state.sweepInFlight += 1;
      state.peakSweepInFlight = Math.max(
        state.peakSweepInFlight,
        state.sweepInFlight,
      );

      try {
        // Both sweeps reach the predicate together, so the status guard is
        // what makes the winner unique.
        await yieldTurn();

        const staleMs = query.values.find(
          (value) => typeof value === 'number',
        );
        const ownedIds = new Set(
          query.values.filter((value) => typeof value === 'string'),
        );
        const cutoff = new Date(state.now.getTime() - staleMs);
        let affected = 0;

        // Critical section: no `await` below.
        for (const row of state.rows) {
          if (row.status !== 'PROCESSING') continue;
          if (row.heartbeatAt.getTime() >= cutoff.getTime()) continue;
          if (ownedIds.has(row.id)) continue;

          const liveAttempt = state.attempts.some(
            (attempt) =>
              attempt.requestLogId === row.id &&
              attempt.createdAt.getTime() > cutoff.getTime(),
          );
          if (liveAttempt) continue;

          row.status = 'FAILED';
          row.errorCode = 'ABANDONED';
          row.failureClass = 'ABANDONED';
          row.finishedAt = nowDate();
          row.latencyMs = Math.max(
            0,
            state.now.getTime() - row.startedAt.getTime(),
          );
          affected += 1;
          state.abandonWrites += 1;
        }

        return affected;
      } finally {
        state.sweepInFlight -= 1;
      }
    },
    requestLog: {
      create: async (args) => {
        const startedAt = args.data.startedAt ?? nowDate();
        const row = {
          id: `log-${state.rows.length + 1}`,
          status: 'PROCESSING',
          statusCode: 0,
          errorCode: null,
          failureClass: null,
          finishedAt: null,
          latencyMs: null,
          ...args.data,
          startedAt,
          // The column default is `now()` in PostgreSQL.
          heartbeatAt: args.data.heartbeatAt ?? nowDate(),
        };

        state.rows.push(row);
        return args.select?.id ? { id: row.id } : row;
      },
      updateMany: async (args) => {
        let count = 0;

        for (const row of state.rows) {
          if (row.id !== args.where.id) continue;
          if (
            args.where.status !== undefined &&
            row.status !== args.where.status
          ) {
            continue;
          }

          Object.assign(row, args.data);
          count += 1;
        }

        return { count };
      },
    },
  };

  return { prisma, state, advance, nowDate, addRow };
}

function instance(prisma) {
  const telemetry = fakeTelemetry();
  return {
    telemetry,
    service: new RequestLogService(prisma, telemetry),
  };
}

test('two instances sharing a database never abandon the other instance’s active request', async () => {
  const db = sharedDatabase();
  const a = instance(db.prisma);
  const b = instance(db.prisma);

  const started = await a.service.start(startInput(db.nowDate()));

  assert.notEqual(started, null);

  // The request has been running for 20 minutes: past the 15-minute stale
  // cutoff measured from `startedAt`. It is still alive, so instance A keeps
  // its heartbeat fresh.
  db.advance(20 * MINUTE);
  assert.equal(await a.service.heartbeatInFlight(), 1);

  const row = db.state.rows.find((candidate) => candidate.id === started.id);

  assert.equal(row.heartbeatAt.getTime(), db.state.now.getTime());

  // Instance B has its own empty in-memory set. Only the durable heartbeat can
  // tell it that A's request is alive.
  assert.equal(await b.service.sweepStaleProcessing(), 0);
  assert.equal(row.status, 'PROCESSING');
  assert.equal(row.errorCode, null);
  assert.equal(db.state.abandonWrites, 0);
  assert.equal(a.telemetry.errors.length, 0);
  assert.equal(b.telemetry.errors.length, 0);
});

test('a crashed instance’s request becomes recoverable once its heartbeat expires', async () => {
  const db = sharedDatabase();
  const a = instance(db.prisma);
  const b = instance(db.prisma);

  const started = await a.service.start(startInput(db.nowDate()));

  assert.notEqual(started, null);

  // Instance A dies: it never heartbeats again. B sweeps after the lease.
  db.advance(16 * MINUTE);

  assert.equal(await b.service.sweepStaleProcessing(), 1);

  const row = db.state.rows.find((candidate) => candidate.id === started.id);

  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'ABANDONED');
  assert.equal(row.failureClass, 'ABANDONED');
  assert.equal(row.statusCode, 0);
  assert.equal(row.finishedAt.getTime(), db.state.now.getTime());
  assert.equal(row.latencyMs, 16 * MINUTE);
});

test('a heartbeat exactly at the cutoff is not stale; one millisecond older is', async () => {
  const db = sharedDatabase();
  const service = instance(db.prisma).service;

  db.addRow({
    id: 'log-boundary',
    startedAt: new Date(db.state.now.getTime() - 30 * MINUTE),
    heartbeatAt: db.state.now,
  });

  db.advance(15 * MINUTE);

  // heartbeatAt === now() - 15 minutes: strictly older-than is required.
  assert.equal(await service.sweepStaleProcessing(), 0);
  assert.equal(db.state.rows[0].status, 'PROCESSING');

  db.advance(1);

  assert.equal(await service.sweepStaleProcessing(), 1);
  assert.equal(db.state.rows[0].status, 'FAILED');
});

test('concurrent sweeps from different instances abandon a row exactly once', async () => {
  const db = sharedDatabase();
  const b = instance(db.prisma);
  const c = instance(db.prisma);

  db.addRow({
    id: 'log-crashed',
    startedAt: new Date(db.state.now.getTime() - 20 * MINUTE),
    heartbeatAt: new Date(db.state.now.getTime() - 20 * MINUTE),
  });

  const results = await Promise.all([
    b.service.sweepStaleProcessing(),
    c.service.sweepStaleProcessing(),
  ]);

  assert.equal(db.state.sweeps, 2);
  assert.equal(db.state.peakSweepInFlight, 2);
  assert.equal(results[0] + results[1], 1);
  assert.equal(db.state.abandonWrites, 1);
  assert.equal(db.state.rows[0].status, 'FAILED');
  assert.equal(db.state.rows[0].errorCode, 'ABANDONED');
});

test('heartbeatInFlight touches only PROCESSING rows this instance owns', async () => {
  const db = sharedDatabase();
  const a = instance(db.prisma);

  const live = await a.service.start(startInput(db.nowDate()));
  const closed = await a.service.start(startInput(db.nowDate()));

  assert.notEqual(live, null);
  assert.notEqual(closed, null);

  await a.service.finalizeSuccess(
    successInput(closed.id, db.nowDate(), { latencyMs: 5 }),
  );

  const closedRow = db.state.rows.find((row) => row.id === closed.id);
  const closedHeartbeat = closedRow.heartbeatAt.getTime();

  db.advance(5 * MINUTE);

  assert.equal(await a.service.heartbeatInFlight(), 1);

  const liveRow = db.state.rows.find((row) => row.id === live.id);

  assert.equal(liveRow.heartbeatAt.getTime(), db.state.now.getTime());
  assert.equal(closedRow.heartbeatAt.getTime(), closedHeartbeat);
  assert.equal(closedRow.status, 'SUCCESS');
});

test('heartbeatInFlight is a no-op when this instance owns no request', async () => {
  const db = sharedDatabase();
  const a = instance(db.prisma);

  assert.equal(await a.service.heartbeatInFlight(), 0);
  assert.equal(db.state.heartbeatQueries, 0);
  assert.equal(a.telemetry.errors.length, 0);
});

test('a heartbeat failure is reported and never thrown', async () => {
  const db = sharedDatabase();
  const a = instance(db.prisma);

  await a.service.start(startInput(db.nowDate()));
  db.state.throwOnHeartbeat = new Error('heartbeat write failed');

  assert.equal(await a.service.heartbeatInFlight(), 0);

  assert.equal(a.telemetry.errors.length, 1);
  assert.equal(
    a.telemetry.errors[0].errorCode,
    'REQUEST_LOG_WRITE_FAILED',
  );
  assert.equal(a.telemetry.errors[0].traceId, 'heartbeat');
  assert.match(a.telemetry.errors[0].errorMessage, /heartbeat write failed/);
});

test('a sweep uses the database clock, not the application clock', async () => {
  // A database clock far away from the test process clock: only a statement
  // that lets PostgreSQL compute the cutoff can classify this row correctly.
  const db = sharedDatabase({ now: new Date('2030-01-01T00:00:00.000Z') });
  const service = instance(db.prisma).service;

  db.addRow({
    id: 'log-db-clock',
    startedAt: new Date(db.state.now.getTime() - 60 * MINUTE),
    heartbeatAt: new Date(db.state.now.getTime() - 16 * MINUTE),
  });

  assert.equal(await service.sweepStaleProcessing(), 1);

  const [query] = db.state.sweepQueries;

  // Both cutoffs are computed by `now()`; the bound values are interval
  // milliseconds, never an application `Date`.
  assert.match(query.sql, /rl\."heartbeatAt" < now\(\) -/);
  assert.match(query.sql, /ra\."createdAt" > now\(\) -/);
  assert.equal(
    query.values.every((value) => typeof value !== 'object' || value === null),
    true,
  );
  assert.equal(
    query.values.filter((value) => typeof value === 'number').length,
    2,
  );
});

test('a late heartbeat cannot resurrect a row another instance already abandoned', async () => {
  const db = sharedDatabase();
  const a = instance(db.prisma);
  const b = instance(db.prisma);

  const started = await a.service.start(startInput(db.nowDate()));

  assert.notEqual(started, null);

  // A is paused long enough for B to reclaim the row.
  db.advance(20 * MINUTE);
  assert.equal(await b.service.sweepStaleProcessing(), 1);

  const row = db.state.rows.find((candidate) => candidate.id === started.id);

  assert.equal(row.status, 'FAILED');

  const abandonedAt = row.finishedAt.getTime();

  // When A resumes, its heartbeat matches no PROCESSING row.
  assert.equal(await a.service.heartbeatInFlight(), 0);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.errorCode, 'ABANDONED');
  assert.equal(row.finishedAt.getTime(), abandonedAt);

  // Finalization is guarded too: the abandoned row is not rewritten.
  assert.equal(
    await a.service.finalizeSuccess(successInput(started.id, db.nowDate())),
    false,
  );
  assert.equal(row.status, 'FAILED');
  assert.equal(row.statusCode, 0);
});

test('the heartbeat interval leaves room for several missed beats inside the stale cutoff', () => {
  assert.equal(
    Number.isInteger(RequestLogService.HEARTBEAT_INTERVAL_MS),
    true,
  );
  assert.ok(RequestLogService.HEARTBEAT_INTERVAL_MS > 0);
  assert.ok(
    RequestLogService.HEARTBEAT_INTERVAL_MS <=
      RequestLogService.STALE_PROCESSING_MS / 5,
    'at least five heartbeats must fit inside the stale cutoff',
  );
});
