const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpException } = require('@nestjs/common');
const { Prisma } = require('@prisma/client');
const {
  createRequestContext,
} = require('../dist/common/context/request-context.js');
const {
  ProviderError,
} = require('../dist/modules/providers/base.provider.js');
const {
  ResilienceService,
} = require('../dist/modules/providers/resilience.service.js');
const {
  GatewayService,
} = require('../dist/modules/gateway/gateway.service.js');
const {
  GatewayController,
} = require('../dist/modules/gateway/gateway.controller.js');

// In-memory only (§8.3): no database, no Nest container, no network. The
// resilience loop is the real one; everything it talks to is a fake, so the
// attempt observations these tests assert on are the ones production emits.

function target(overrides = {}) {
  return {
    modelId: overrides.modelId ?? 'model-1',
    modelName: overrides.modelName ?? 'public-model',
    upstreamModel: overrides.upstreamModel ?? 'upstream-model',
    provider: overrides.provider ?? 'mock',
    baseUrl: undefined,
    timeoutMs: overrides.timeoutMs ?? 1000,
    maxRetries: overrides.maxRetries ?? 0,
    // 0 disables cooldown state, keeping each test's routing deterministic.
    cooldownMs: overrides.cooldownMs ?? 0,
  };
}

function providerResponse(overrides = {}) {
  return {
    response: {
      id: overrides.id ?? 'completion-1',
      object: 'chat.completion',
      created: 1,
      model: overrides.model ?? 'upstream-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: overrides.promptTokens ?? 2,
        completion_tokens: overrides.completionTokens ?? 3,
        total_tokens: overrides.totalTokens ?? 5,
      },
    },
    latencyMs: overrides.latencyMs ?? 25,
    traceId: overrides.traceId ?? 'trace-1',
  };
}

function fakeRequestLogs({
  id = 'log-1',
  failStart = false,
  failAppend = false,
  failFinalizeSuccess = false,
} = {}) {
  const started = [];
  const attempts = [];
  const successes = [];
  const failures = [];

  return {
    started,
    attempts,
    successes,
    failures,
    start: async (input) => {
      if (failStart) {
        throw new Error('request log start failed');
      }
      started.push(input);
      return { id };
    },
    appendAttempt: async (input) => {
      if (failAppend) {
        throw new Error('attempt write failed');
      }
      attempts.push(input);
    },
    finalizeSuccess: async (input) => {
      if (failFinalizeSuccess) {
        throw new Error('finalize failed');
      }
      successes.push(input);
      return true;
    },
    finalizeFailure: async (input) => {
      failures.push(input);
      return true;
    },
  };
}

function fakeTelemetry() {
  const requests = [];
  const errors = [];

  return {
    requests,
    errors,
    logRequest: (event) => {
      requests.push(event);
    },
    logError: (event) => {
      errors.push(event);
    },
  };
}

function contextFor(overrides = {}) {
  return createRequestContext({
    user: { id: 'user-1', apiKeyId: 'key-1' },
    traceId: overrides.traceId ?? 'trace-1',
    requestId: overrides.requestId ?? 'request-1',
    requestedModel: overrides.requestedModel ?? 'public-model',
    isStream: overrides.isStream === true,
  });
}

function createGateway({
  targets = [target()],
  handler = async () => providerResponse(),
  requestLogs = fakeRequestLogs(),
  cost = null,
  costThrows = false,
} = {}) {
  const telemetry = fakeTelemetry();
  const costCalls = [];
  const providerCalls = [];

  const service = new GatewayService(
    {
      resolveRoute: async (model) => ({
        requestedModel: model,
        targets,
      }),
    },
    {
      chatCompletion: async (...args) => {
        providerCalls.push(args);
        return handler(...args);
      },
    },
    requestLogs,
    telemetry,
    { resolve: () => ({ apiKey: undefined, baseUrl: undefined, source: 'none' }) },
    new ResilienceService(),
    {
      calculate: async (input) => {
        costCalls.push(input);
        if (costThrows) {
          throw new Error('pricing lookup unavailable');
        }
        return cost;
      },
    },
  );

  // Keep the reporter quiet: these tests assert on the fakes, not on stdout.
  service.logger.error = () => {};
  service.logger.warn = () => {};

  return { service, telemetry, costCalls, providerCalls, requestLogs };
}

function request(overrides = {}) {
  return {
    model: 'public-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

test('records one SUCCEEDED attempt for a single-target success', async () => {
  const requestLogs = fakeRequestLogs();
  const gateway = createGateway({ requestLogs });
  const context = contextFor();

  const response = await gateway.service.createCompletion(request(), context);

  // The provider response is returned, with the trace ID attached.
  assert.equal(response.trace_id, 'trace-1');
  assert.equal(response.id, 'completion-1');
  assert.equal(response.choices[0].message.content, 'hello');

  // The PROCESSING row is created before routing, with only known fields.
  assert.equal(requestLogs.started.length, 1);
  assert.equal(requestLogs.started[0].traceId, 'trace-1');
  assert.equal(requestLogs.started[0].requestId, 'request-1');
  assert.equal(requestLogs.started[0].userId, 'user-1');
  assert.equal(requestLogs.started[0].apiKeyId, 'key-1');
  assert.equal(requestLogs.started[0].requestedModel, 'public-model');
  assert.equal(requestLogs.started[0].isStream, false);
  assert.equal(requestLogs.started[0].startedAt, context.startedAt);

  // Exactly one attempt, correctly addressed and timed.
  assert.equal(requestLogs.attempts.length, 1);

  const attempt = requestLogs.attempts[0];

  assert.equal(attempt.requestLogId, 'log-1');
  assert.equal(attempt.attemptIndex, 0);
  assert.equal(attempt.attemptOnTarget, 0);
  assert.equal(attempt.isFallback, false);
  assert.equal(attempt.status, 'SUCCEEDED');
  assert.equal(attempt.provider, 'mock');
  assert.equal(attempt.model, 'public-model');
  assert.equal(attempt.servedModel, 'upstream-model');
  assert.equal(attempt.isStream, false);
  assert.equal(attempt.promptTokens, 2);
  assert.equal(attempt.completionTokens, 3);
  assert.equal(attempt.totalTokens, 5);
  assert.equal(attempt.providerRequestId, 'completion-1');
  assert.equal(attempt.failureClass, null);
  assert.equal(attempt.errorCode, null);
  assert.equal(attempt.errorMessage, null);

  // The latency split comes from the one place that computes it.
  assert.equal(attempt.upstreamLatencyMs, 25);
  assert.equal(attempt.overheadMs, Math.max(0, attempt.latencyMs - 25));
  assert.ok(attempt.overheadMs >= 0);

  // The parent leaves PROCESSING only after the attempt rows are on disk.
  assert.equal(requestLogs.successes.length, 1);

  const finalized = requestLogs.successes[0];

  assert.equal(finalized.requestLogId, 'log-1');
  assert.equal(finalized.statusCode, 200);
  assert.equal(finalized.requestedModel, 'public-model');
  assert.equal(finalized.servedModel, 'upstream-model');
  assert.equal(finalized.provider, 'mock');
  assert.equal(finalized.modelId, 'model-1');
  assert.equal(finalized.attemptCount, 1);
  assert.equal(finalized.fallbackUsed, false);
  assert.equal(finalized.totalTokens, 5);
  assert.equal(finalized.pricingId, null);
  assert.equal(finalized.totalCost, null);
  assert.equal(finalized.currency, null);

  assert.equal(requestLogs.failures.length, 0);
  assert.equal(gateway.telemetry.errors.length, 0);
  assert.equal(gateway.telemetry.requests.length, 1);
});

test('records two attempts on the same target when a retry succeeds', async () => {
  let calls = 0;

  const requestLogs = fakeRequestLogs();
  const gateway = createGateway({
    requestLogs,
    targets: [target({ maxRetries: 1 })],
    handler: async () => {
      calls += 1;
      if (calls === 1) {
        throw new ProviderError('PROVIDER_TIMEOUT', 'timed out');
      }
      return providerResponse();
    },
  });

  const response = await gateway.service.createCompletion(
    request(),
    contextFor(),
  );

  assert.equal(response.id, 'completion-1');
  assert.equal(calls, 2);
  assert.equal(requestLogs.attempts.length, 2);

  const [first, second] = requestLogs.attempts;

  // The failed attempt is recorded before the retry decision, so the retry
  // cannot erase it.
  assert.equal(first.attemptIndex, 0);
  assert.equal(first.attemptOnTarget, 0);
  assert.equal(first.isFallback, false);
  assert.equal(first.status, 'FAILED');
  assert.equal(first.failureClass, 'TIMEOUT');
  assert.equal(first.errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(first.errorMessage, 'timed out');
  assert.equal(first.upstreamLatencyMs, null);
  assert.equal(first.overheadMs, null);

  assert.equal(second.attemptIndex, 1);
  assert.equal(second.attemptOnTarget, 1);
  assert.equal(second.isFallback, false);
  assert.equal(second.status, 'SUCCEEDED');
  assert.equal(second.upstreamLatencyMs, 25);

  // A retry is not a fallback: both attempts stayed on the primary target.
  assert.equal(requestLogs.successes.length, 1);
  assert.equal(requestLogs.successes[0].attemptCount, 2);
  assert.equal(requestLogs.successes[0].fallbackUsed, false);
  assert.equal(requestLogs.successes[0].servedModel, 'upstream-model');
  assert.equal(requestLogs.failures.length, 0);
});

test('marks fallbackUsed when the primary fails and the fallback serves', async () => {
  const requestLogs = fakeRequestLogs();
  const gateway = createGateway({
    requestLogs,
    targets: [
      target({
        modelId: 'primary-id',
        modelName: 'primary',
        upstreamModel: 'primary-upstream',
      }),
      target({
        modelId: 'fallback-id',
        modelName: 'fallback',
        upstreamModel: 'fallback-upstream',
      }),
    ],
    handler: async (provider, providerRequest) => {
      if (providerRequest.model === 'primary-upstream') {
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'primary is down');
      }
      return providerResponse({ model: 'fallback-upstream' });
    },
  });

  const response = await gateway.service.createCompletion(
    request({ model: 'primary' }),
    contextFor(),
  );

  assert.equal(response.id, 'completion-1');
  assert.equal(requestLogs.attempts.length, 2);

  const [primary, fallback] = requestLogs.attempts;

  assert.equal(primary.isFallback, false);
  assert.equal(primary.status, 'FAILED');
  assert.equal(primary.model, 'primary');
  assert.equal(primary.failureClass, 'PROVIDER_UNAVAILABLE');
  assert.equal(primary.attemptOnTarget, 0);

  assert.equal(fallback.isFallback, true);
  assert.equal(fallback.status, 'SUCCEEDED');
  assert.equal(fallback.attemptIndex, 1);
  assert.equal(fallback.attemptOnTarget, 0);
  assert.equal(fallback.model, 'fallback');
  assert.equal(fallback.servedModel, 'fallback-upstream');

  assert.equal(requestLogs.successes.length, 1);

  const finalized = requestLogs.successes[0];

  assert.equal(finalized.attemptCount, 2);
  assert.equal(finalized.fallbackUsed, true);
  assert.equal(finalized.modelId, 'fallback-id');
  assert.equal(finalized.provider, 'mock');
  assert.equal(finalized.servedModel, 'fallback-upstream');
});

test('finalizes FAILED with the last failure when every target fails', async () => {
  const requestLogs = fakeRequestLogs();
  const lastFailure = new ProviderError(
    'PROVIDER_TIMEOUT',
    'upstream timed out for sk-abc1234',
  );

  const gateway = createGateway({
    requestLogs,
    targets: [
      target({ modelId: 'primary-id', modelName: 'primary', upstreamModel: 'primary-upstream' }),
      target({ modelId: 'fallback-id', modelName: 'fallback', upstreamModel: 'fallback-upstream' }),
    ],
    handler: async (provider, providerRequest) => {
      if (providerRequest.model === 'fallback-upstream') {
        throw lastFailure;
      }
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'primary is down');
    },
  });

  await assert.rejects(
    () => gateway.service.createCompletion(request(), contextFor()),
    (error) => {
      // The original error is rethrown untouched: the controller owns mapping.
      assert.equal(error, lastFailure);
      return true;
    },
  );

  assert.equal(requestLogs.attempts.length, 2);
  for (const attempt of requestLogs.attempts) {
    assert.equal(attempt.status, 'FAILED');
    assert.equal(attempt.requestLogId, 'log-1');
  }

  assert.equal(requestLogs.attempts[0].failureClass, 'PROVIDER_UNAVAILABLE');
  assert.equal(requestLogs.attempts[1].failureClass, 'TIMEOUT');

  assert.equal(requestLogs.successes.length, 0);
  assert.equal(requestLogs.failures.length, 1);

  const finalized = requestLogs.failures[0];

  // The last failure wins, and the message is sanitized before persistence.
  assert.equal(finalized.statusCode, 504);
  assert.equal(finalized.failureClass, 'TIMEOUT');
  assert.equal(finalized.errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(finalized.errorMessage, 'upstream timed out for [redacted]');
  assert.equal(finalized.attemptCount, 2);
  assert.equal(finalized.fallbackUsed, true);

  // The failure is observable through telemetry with the wire code.
  assert.equal(gateway.telemetry.requests.length, 0);
  assert.equal(gateway.telemetry.errors.length, 1);
  assert.equal(gateway.telemetry.errors[0].errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(gateway.telemetry.errors[0].statusCode, 504);
});

test('returns the provider response when the request log write fails', async () => {
  const requestLogs = fakeRequestLogs({
    failAppend: true,
    failFinalizeSuccess: true,
  });
  const gateway = createGateway({ requestLogs });

  const response = await gateway.service.createCompletion(
    request(),
    contextFor(),
  );

  // The paid response is unaffected by every logging step failing (§S1).
  assert.equal(response.id, 'completion-1');
  assert.equal(response.trace_id, 'trace-1');
  assert.equal(response.choices[0].message.content, 'hello');

  // Nothing was persisted, and each failure is reported, not swallowed.
  assert.equal(requestLogs.started.length, 1);
  assert.equal(requestLogs.attempts.length, 0);
  assert.equal(requestLogs.successes.length, 0);

  assert.equal(gateway.telemetry.errors.length, 2);
  for (const event of gateway.telemetry.errors) {
    assert.equal(event.errorCode, 'REQUEST_LOG_WRITE_FAILED');
    assert.equal(event.statusCode, 0);
    assert.equal(event.traceId, 'trace-1');
    assert.match(event.errorMessage, /request-log\./);
  }

  // The usage event still fires exactly once.
  assert.equal(gateway.telemetry.requests.length, 1);
});

test('stores the pricing snapshot so totalCost reproduces the arithmetic', async () => {
  const requestLogs = fakeRequestLogs();
  const inputCost = new Prisma.Decimal('0.00015');
  const outputCost = new Prisma.Decimal('0.0003');
  const totalCost = new Prisma.Decimal('0.00045');

  const gateway = createGateway({
    requestLogs,
    handler: async () =>
      providerResponse({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }),
    cost: {
      pricingId: 'price-1',
      currency: 'USD',
      inputCost,
      outputCost,
      totalCost,
    },
  });

  const context = contextFor();
  const response = await gateway.service.createCompletion(request(), context);

  assert.equal(response.id, 'completion-1');

  // Pricing attaches to the upstream model, for this user, at request start.
  assert.equal(gateway.costCalls.length, 2);

  for (const call of gateway.costCalls) {
    assert.equal(call.provider, 'mock');
    assert.equal(call.model, 'upstream-model');
    assert.equal(call.userId, 'user-1');
    assert.equal(call.at, context.startedAt);
    assert.equal(call.promptTokens, 1000);
    assert.equal(call.completionTokens, 500);
  }

  const attempt = requestLogs.attempts[0];

  assert.equal(attempt.pricingId, 'price-1');
  assert.equal(attempt.inputCost.toString(), '0.00015');
  assert.equal(attempt.outputCost.toString(), '0.0003');
  assert.equal(attempt.totalCost.toString(), '0.00045');

  const finalized = requestLogs.successes[0];

  assert.equal(finalized.promptTokens, 1000);
  assert.equal(finalized.completionTokens, 500);
  assert.equal(finalized.totalTokens, 1500);
  assert.equal(finalized.pricingId, 'price-1');
  assert.equal(finalized.currency, 'USD');
  assert.equal(finalized.totalCost.toString(), '0.00045');

  // The stored tokens + pricing snapshot reproduce the stored total exactly.
  const recomputed = new Prisma.Decimal(1000)
    .dividedBy(1_000_000)
    .times('0.15')
    .plus(new Prisma.Decimal(500).dividedBy(1_000_000).times('0.6'));

  assert.equal(finalized.totalCost.toString(), recomputed.toString());
  assert.equal(gateway.telemetry.errors.length, 0);
});

test('records null cost for an unknown price and still returns the response', async () => {
  const requestLogs = fakeRequestLogs();
  const gateway = createGateway({ requestLogs, cost: null });

  const response = await gateway.service.createCompletion(
    request(),
    contextFor(),
  );

  assert.equal(response.id, 'completion-1');
  assert.equal(gateway.costCalls.length, 2);

  // `null` is "unknown", never `0`: zero means free (§6.6).
  const attempt = requestLogs.attempts[0];

  assert.strictEqual(attempt.pricingId, null);
  assert.strictEqual(attempt.inputCost, null);
  assert.strictEqual(attempt.outputCost, null);
  assert.strictEqual(attempt.totalCost, null);

  const finalized = requestLogs.successes[0];

  assert.strictEqual(finalized.pricingId, null);
  assert.strictEqual(finalized.currency, null);
  assert.strictEqual(finalized.totalCost, null);

  // The request itself is complete: tokens are still recorded.
  assert.equal(finalized.totalTokens, 5);
  assert.equal(gateway.telemetry.errors.length, 0);
});

test('returns the provider response when the pricing lookup throws', async () => {
  const requestLogs = fakeRequestLogs();
  const gateway = createGateway({ requestLogs, costThrows: true });

  const response = await gateway.service.createCompletion(
    request(),
    contextFor(),
  );

  // A pricing failure must never turn a paid completion into a 500 (§S1).
  assert.equal(response.id, 'completion-1');
  assert.equal(response.trace_id, 'trace-1');
  assert.equal(response.choices[0].message.content, 'hello');

  assert.equal(gateway.costCalls.length, 2);

  // The attempt is still written; only its cost is unknown.
  assert.equal(requestLogs.attempts.length, 1);
  assert.strictEqual(requestLogs.attempts[0].totalCost, null);
  assert.strictEqual(requestLogs.attempts[0].pricingId, null);
  assert.equal(requestLogs.attempts[0].status, 'SUCCEEDED');

  assert.equal(requestLogs.successes.length, 1);
  assert.strictEqual(requestLogs.successes[0].totalCost, null);
  assert.strictEqual(requestLogs.successes[0].pricingId, null);
  assert.strictEqual(requestLogs.successes[0].currency, null);

  // Both pricing failures are observable, not swallowed.
  assert.equal(gateway.telemetry.errors.length, 2);
  for (const event of gateway.telemetry.errors) {
    assert.equal(event.errorCode, 'REQUEST_LOG_WRITE_FAILED');
  }

  assert.equal(gateway.telemetry.requests.length, 1);
});

test('records a FAILED caller-fault row for a rejected request with no attempts', async () => {
  const requestLogs = fakeRequestLogs();
  const gateway = createGateway({ requestLogs });
  let forwarded = 0;

  // A real GatewayController over a real GatewayService: only `createCompletion`
  // is short-circuited, because a rejected request must never reach it.
  const controller = new GatewayController({
    createCompletion: async () => {
      forwarded += 1;
      return {};
    },
    recordRejectedRequest: (context, input) =>
      gateway.service.recordRejectedRequest(context, input),
  });

  const body = request({ stream: true });
  let rejected;

  await assert.rejects(
    () =>
      controller.createCompletion(
        body,
        { id: 'user-1', apiKeyId: 'key-1' },
        'trace-1',
        'request-1',
      ),
    (error) => {
      rejected = error;

      // The wire contract is unchanged: same code, message, param, status.
      assert.ok(error instanceof HttpException);
      assert.equal(error.getStatus(), 400);

      const response = error.getResponse();

      assert.equal(response.code, 'UNSUPPORTED_FEATURE');
      assert.equal(
        response.message,
        'Streaming is not supported yet. Set stream to false or omit it.',
      );
      assert.equal(response.param, 'stream');
      assert.equal(response.statusCode, 400);

      return true;
    },
  );

  // Routing was never attempted: no provider call, no attempts.
  assert.equal(forwarded, 0);
  assert.equal(gateway.providerCalls.length, 0);

  // One PROCESSING row was opened and immediately closed as caller fault.
  assert.equal(requestLogs.started.length, 1);
  assert.equal(requestLogs.started[0].traceId, 'trace-1');
  assert.equal(requestLogs.started[0].requestId, 'request-1');
  assert.equal(requestLogs.started[0].requestedModel, 'public-model');
  assert.equal(requestLogs.started[0].isStream, true);

  assert.equal(requestLogs.attempts.length, 0);
  assert.equal(requestLogs.successes.length, 0);
  assert.equal(requestLogs.failures.length, 1);

  const finalized = requestLogs.failures[0];

  assert.equal(finalized.requestLogId, 'log-1');
  assert.equal(finalized.statusCode, 400);
  assert.equal(finalized.failureClass, 'CALLER_FAULT');
  assert.equal(finalized.errorCode, 'UNSUPPORTED_FEATURE');
  assert.equal(finalized.attemptCount, 0);
  assert.equal(finalized.fallbackUsed, false);
  assert.equal(finalized.latencyMs, 0);
  assert.ok(finalized.finishedAt instanceof Date);

  // A logging failure must not alter the response: identical exception.
  const failingController = new GatewayController({
    createCompletion: async () => {
      throw new Error('unreachable');
    },
    recordRejectedRequest: async () => {
      throw new Error('request log write failed');
    },
  });

  await assert.rejects(
    () =>
      failingController.createCompletion(
        body,
        { id: 'user-1', apiKeyId: 'key-1' },
        'trace-2',
        'request-2',
      ),
    (error) => {
      assert.ok(error instanceof HttpException);
      assert.equal(error.getStatus(), rejected.getStatus());
      assert.deepEqual(error.getResponse(), rejected.getResponse());
      return true;
    },
  );
});
