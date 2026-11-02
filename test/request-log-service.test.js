const test = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
const {
  deriveLatencySplit,
} = require('../dist/common/observability/attempt-observation.js');
const {
  toAttemptRecord,
} = require('../dist/modules/logging/request-log.types.js');
const {
  RequestLogService,
} = require('../dist/modules/logging/request-log.service.js');

// In-memory only: no database, no Nest container. The fakes record the exact
// Prisma arguments the service passes, which is what these tests assert on.

const TARGET = {
  modelId: 'model-1',
  modelName: 'gpt-4o-mini',
  upstreamModel: 'gpt-4o-mini-2024-07-18',
  provider: 'openai',
  timeoutMs: 30_000,
  maxRetries: 1,
  cooldownMs: 30_000,
};

const STARTED_AT = new Date('2026-11-02T10:00:00.000Z');
const FINISHED_AT = new Date('2026-11-02T10:00:00.120Z');

function fakePrisma(overrides = {}) {
  const calls = { createLog: [], createAttempt: [], updateMany: [] };

  return {
    calls,
    requestLog: {
      create: async (args) => {
        calls.createLog.push(args);
        return overrides.createLog ? overrides.createLog(args) : { id: 'log-1' };
      },
      updateMany: async (args) => {
        calls.updateMany.push(args);
        return overrides.updateMany ? overrides.updateMany(args) : { count: 1 };
      },
    },
    requestAttempt: {
      create: async (args) => {
        calls.createAttempt.push(args);
        return overrides.createAttempt
          ? overrides.createAttempt(args)
          : { id: 'attempt-1' };
      },
    },
  };
}

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

function startInput(overrides = {}) {
  return {
    traceId: 'trace-1',
    requestId: 'request-1',
    userId: 'user-1',
    apiKeyId: 'key-1',
    requestedModel: 'gpt-4o-mini',
    isStream: false,
    startedAt: STARTED_AT,
    ...overrides,
  };
}

function attemptInput(overrides = {}) {
  return {
    requestLogId: 'log-1',
    attemptIndex: 0,
    attemptOnTarget: 0,
    isFallback: false,
    provider: 'openai',
    model: 'gpt-4o-mini',
    servedModel: 'gpt-4o-mini-2024-07-18',
    status: 'SUCCEEDED',
    isStream: false,
    latencyMs: 120,
    upstreamLatencyMs: 100,
    overheadMs: 20,
    createdAt: FINISHED_AT,
    ...overrides,
  };
}

function successInput(overrides = {}) {
  return {
    requestLogId: 'log-1',
    statusCode: 200,
    modelId: 'model-1',
    requestedModel: 'gpt-4o-mini',
    servedModel: 'gpt-4o-mini-2024-07-18',
    provider: 'openai',
    attemptCount: 2,
    fallbackUsed: true,
    currency: 'USD',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    pricingId: 'price-1',
    totalCost: new Prisma.Decimal('0.00045'),
    latencyMs: 250,
    finishedAt: FINISHED_AT,
    ...overrides,
  };
}

function failureInput(overrides = {}) {
  return {
    requestLogId: 'log-1',
    statusCode: 504,
    failureClass: 'TIMEOUT',
    errorCode: 'PROVIDER_TIMEOUT',
    errorMessage: 'upstream timed out for sk-abc0000def',
    modelId: null,
    provider: null,
    servedModel: null,
    attemptCount: 2,
    fallbackUsed: true,
    latencyMs: 30_000,
    finishedAt: FINISHED_AT,
    ...overrides,
  };
}

test('start writes a PROCESSING row with the known context fields', async () => {
  const prisma = fakePrisma();
  const telemetry = fakeTelemetry();
  const service = new RequestLogService(prisma, telemetry);

  const started = await service.start(startInput());

  assert.deepEqual(started, { id: 'log-1' });
  assert.equal(prisma.calls.createLog.length, 1);

  const { data, select } = prisma.calls.createLog[0];

  assert.equal(data.traceId, 'trace-1');
  assert.equal(data.requestId, 'request-1');
  assert.equal(data.userId, 'user-1');
  assert.equal(data.apiKeyId, 'key-1');
  assert.equal(data.requestedModel, 'gpt-4o-mini');
  assert.equal(data.isStream, false);
  assert.equal(data.startedAt, STARTED_AT);
  assert.equal(data.status, 'PROCESSING');
  assert.equal(data.statusCode, 0);
  assert.deepEqual(select, { id: true });

  // Nothing routing would have supplied is invented before routing (§6.1).
  assert.equal('modelId' in data, false);
  assert.equal('provider' in data, false);
  assert.equal('servedModel' in data, false);
  assert.equal('totalCost' in data, false);

  assert.equal(telemetry.errors.length, 0);
});

test('toAttemptRecord derives the latency split once and overheadMs is never negative', () => {
  const classify = () => {
    throw new Error('classify must not run for a successful attempt');
  };

  // Success: wall 120ms, adapter-measured upstream 100ms.
  const observedSuccess = {
    attemptIndex: 3,
    attemptOnTarget: 1,
    isFallback: true,
    target: TARGET,
    status: 'SUCCEEDED',
    latencyMs: 120,
    result: {
      response: {
        id: 'chatcmpl-1',
        model: 'gpt-4o-mini-2024-07-18',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      latencyMs: 100,
    },
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
  };

  const split = deriveLatencySplit(observedSuccess);
  assert.deepEqual(split, { upstreamLatencyMs: 100, overheadMs: 20 });

  const record = toAttemptRecord(observedSuccess, classify);

  // The draft carries exactly what the single split function produced.
  assert.equal(record.upstreamLatencyMs, split.upstreamLatencyMs);
  assert.equal(record.overheadMs, split.overheadMs);
  assert.equal(record.attemptIndex, 3);
  assert.equal(record.attemptOnTarget, 1);
  assert.equal(record.isFallback, true);
  assert.equal(record.provider, 'openai');
  assert.equal(record.model, 'gpt-4o-mini');
  assert.equal(record.servedModel, 'gpt-4o-mini-2024-07-18');
  assert.equal(record.status, 'SUCCEEDED');
  assert.equal(record.promptTokens, 10);
  assert.equal(record.completionTokens, 5);
  assert.equal(record.totalTokens, 15);
  assert.equal(record.providerRequestId, 'chatcmpl-1');
  assert.equal(record.failureClass, null);
  assert.equal(record.errorCode, null);
  assert.equal(record.errorMessage, null);
  assert.equal(record.providerStatus, null);
  assert.equal(record.retryAfterMs, null);
  assert.equal(record.timeToFirstTokenMs, null);
  assert.equal(record.credentialId, null);
  assert.equal(record.createdAt, FINISHED_AT);

  // Clock skew: the adapter reports more time than the loop measured. The
  // upstream number is kept honest and the overhead is clamped, never negative.
  const skewed = {
    ...observedSuccess,
    latencyMs: 50,
    result: { ...observedSuccess.result, latencyMs: 80 },
  };

  assert.deepEqual(deriveLatencySplit(skewed), {
    upstreamLatencyMs: 80,
    overheadMs: 0,
  });

  // Failure: no provider response means no timing at all, not a guess.
  const failure = {
    attemptIndex: 4,
    attemptOnTarget: 0,
    isFallback: false,
    target: TARGET,
    status: 'FAILED',
    latencyMs: 900,
    error: new Error('socket hang up'),
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
  };

  const failedRecord = toAttemptRecord(failure, () => ({
    failureClass: 'PROVIDER_ERROR',
    wireCode: 'PROVIDER_ERROR',
    message: 'socket hang up',
    providerStatus: 502,
  }));

  assert.equal(failedRecord.upstreamLatencyMs, null);
  assert.equal(failedRecord.overheadMs, null);
  assert.equal(failedRecord.latencyMs, 900);
  assert.equal(failedRecord.failureClass, 'PROVIDER_ERROR');
  assert.equal(failedRecord.errorCode, 'PROVIDER_ERROR');
  assert.equal(failedRecord.errorMessage, 'socket hang up');
  assert.equal(failedRecord.providerStatus, 502);
  assert.equal(failedRecord.promptTokens, null);
  assert.equal(failedRecord.completionTokens, null);
  assert.equal(failedRecord.providerRequestId, null);
});

test('appendAttempt persists overheadMs verbatim and sanitizes errors', async () => {
  const prisma = fakePrisma();
  const telemetry = fakeTelemetry();
  const service = new RequestLogService(prisma, telemetry);

  await service.appendAttempt(
    attemptInput({
      attemptIndex: 1,
      status: 'FAILED',
      servedModel: null,
      providerStatus: 429,
      failureClass: 'RATE_LIMIT',
      errorCode: 'PROVIDER_RATE_LIMIT',
      // A control character splits the secret: redaction must run after
      // normalisation or `sk-abcd1234` would reach the database intact.
      errorMessage: 'rate limited for sk-ab\u0000cd1234 ',
      latencyMs: 900,
      upstreamLatencyMs: 10,
      overheadMs: 42,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    }),
  );

  assert.equal(prisma.calls.createAttempt.length, 1);

  const { data } = prisma.calls.createAttempt[0];

  // Verbatim: the service never recomputes the split it was given.
  assert.equal(data.upstreamLatencyMs, 10);
  assert.equal(data.overheadMs, 42);
  assert.equal(data.errorMessage, 'rate limited for [redacted]');
  assert.equal(data.requestLogId, 'log-1');
  assert.equal(data.attemptIndex, 1);
  assert.equal(data.status, 'FAILED');
  assert.equal(data.providerStatus, 429);
  assert.equal(data.failureClass, 'RATE_LIMIT');
  assert.equal(data.errorCode, 'PROVIDER_RATE_LIMIT');

  // Reserved columns are written as null, never omitted.
  for (const field of ['retryAfterMs', 'timeToFirstTokenMs', 'credentialId']) {
    assert.equal(field in data, true, `${field} must be present`);
    assert.equal(data[field], null);
  }

  assert.equal(telemetry.errors.length, 0);

  // P2002 means the unique constraint already holds this attempt: a replay,
  // mapped to a debug line rather than a reported failure.
  const duplicateError = new Error('Unique constraint failed');
  duplicateError.code = 'P2002';

  const duplicatePrisma = fakePrisma({
    createAttempt: () => {
      throw duplicateError;
    },
  });
  const duplicateTelemetry = fakeTelemetry();
  const duplicateService = new RequestLogService(
    duplicatePrisma,
    duplicateTelemetry,
  );

  await duplicateService.appendAttempt(attemptInput({ attemptIndex: 1 }));

  assert.equal(duplicateTelemetry.errors.length, 0);
});

test('finalizeSuccess is guarded by PROCESSING status', async () => {
  const prisma = fakePrisma();
  const telemetry = fakeTelemetry();
  const service = new RequestLogService(prisma, telemetry);

  assert.equal(await service.finalizeSuccess(successInput()), true);

  const { where, data } = prisma.calls.updateMany[0];

  assert.deepEqual(where, { id: 'log-1', status: 'PROCESSING' });
  assert.equal(data.status, 'SUCCESS');
  assert.equal(data.statusCode, 200);
  assert.equal(data.modelId, 'model-1');
  assert.equal(data.provider, 'openai');
  assert.equal(data.servedModel, 'gpt-4o-mini-2024-07-18');
  assert.equal(data.attemptCount, 2);
  assert.equal(data.fallbackUsed, true);
  assert.equal(data.currency, 'USD');
  assert.equal(data.totalTokens, 15);
  assert.equal(data.pricingId, 'price-1');
  assert.equal(data.totalCost.toString(), '0.00045');
  assert.equal(data.latencyMs, 250);
  assert.equal(data.finishedAt, FINISHED_AT);
  assert.equal(data.failureClass, null);
  assert.equal(data.errorCode, null);
  assert.equal(data.errorMessage, null);

  // Another writer already closed the row: this call did not finalize it.
  const racePrisma = fakePrisma({ updateMany: () => ({ count: 0 }) });
  const raceService = new RequestLogService(racePrisma, telemetry);

  assert.equal(await raceService.finalizeSuccess(successInput()), false);
  assert.deepEqual(racePrisma.calls.updateMany[0].where, {
    id: 'log-1',
    status: 'PROCESSING',
  });
  assert.equal(telemetry.errors.length, 0);
});

test('finalizeFailure stores the last failure class and wire code', async () => {
  const prisma = fakePrisma();
  const telemetry = fakeTelemetry();
  const service = new RequestLogService(prisma, telemetry);

  assert.equal(await service.finalizeFailure(failureInput()), true);

  const { where, data } = prisma.calls.updateMany[0];

  assert.deepEqual(where, { id: 'log-1', status: 'PROCESSING' });
  assert.equal(data.status, 'FAILED');
  assert.equal(data.statusCode, 504);
  assert.equal(data.failureClass, 'TIMEOUT');
  assert.equal(data.errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(data.errorMessage, 'upstream timed out for [redacted]');
  assert.equal(data.attemptCount, 2);
  assert.equal(data.fallbackUsed, true);
  assert.equal(data.latencyMs, 30_000);
  assert.equal(data.finishedAt, FINISHED_AT);
  // Optional routing fields are written as null, not omitted.
  assert.equal(data.modelId, null);
  assert.equal(data.provider, null);
  assert.equal(data.servedModel, null);

  const racePrisma = fakePrisma({ updateMany: () => ({ count: 0 }) });
  const raceService = new RequestLogService(racePrisma, telemetry);

  assert.equal(await raceService.finalizeFailure(failureInput()), false);
  assert.equal(telemetry.errors.length, 0);
});

test('a failed write is swallowed and reported to telemetry', async () => {
  const databaseError = () =>
    new Error('P1001: cannot reach database server');

  const prisma = {
    requestLog: {
      create: async () => {
        throw databaseError();
      },
      updateMany: async () => {
        throw databaseError();
      },
    },
    requestAttempt: {
      create: async () => {
        throw databaseError();
      },
    },
  };
  const telemetry = fakeTelemetry();
  const service = new RequestLogService(prisma, telemetry);

  assert.equal(await service.start(startInput()), null);
  await service.appendAttempt(attemptInput());
  assert.equal(await service.finalizeSuccess(successInput()), false);
  assert.equal(await service.finalizeFailure(failureInput()), false);

  assert.equal(telemetry.errors.length, 4);

  for (const event of telemetry.errors) {
    assert.equal(event.errorCode, 'REQUEST_LOG_WRITE_FAILED');
    assert.equal(typeof event.errorMessage, 'string');
    assert.match(event.errorMessage, /cannot reach database server/);
  }

  // Correlation key and the real status when one exists, 0 otherwise (§6.8).
  assert.equal(telemetry.errors[0].traceId, 'trace-1');
  assert.equal(telemetry.errors[0].statusCode, 0);
  assert.equal(telemetry.errors[1].traceId, 'log-1');
  assert.equal(telemetry.errors[1].statusCode, 0);
  assert.equal(telemetry.errors[2].statusCode, 200);
  assert.equal(telemetry.errors[3].statusCode, 504);
});
