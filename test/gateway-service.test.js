const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRequestContext,
} = require('../dist/common/context/request-context.js');
const { GatewayService } = require('../dist/modules/gateway/gateway.service.js');

const user = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'DEVELOPER',
  apiKeyId: 'key-1',
  ownerId: 'user-1',
  ownerType: 'USER',
};

const target = {
  modelId: 'model-1',
  modelName: 'public-model',
  upstreamModel: 'upstream-model',
  provider: 'mock',
  timeoutMs: 1000,
  maxRetries: 0,
  cooldownMs: 0,
};

function requestContext() {
  return createRequestContext({
    user,
    traceId: 'trace-1',
    requestId: 'request-1',
    requestedModel: 'public-model',
  });
}

function createGatewayService({ failToPersist = false } = {}) {
  const started = [];
  const attempts = [];
  const finalized = [];
  const failures = [];
  const telemetryEvents = [];
  const telemetryErrors = [];
  const providerCalls = [];
  const persistenceErrors = [];
  const costCalls = [];

  const providerResponse = {
    response: {
      id: 'completion-1',
      object: 'chat.completion',
      created: 1,
      model: 'upstream-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    },
    latencyMs: 25,
    traceId: 'trace-1',
  };

  // `RequestLogService` fake: same four methods the gateway depends on.
  const requestLogs = {
    start: async (input) => {
      if (failToPersist) {
        throw new Error('database unavailable');
      }
      started.push(input);
      return { id: 'log-1' };
    },
    appendAttempt: async (input) => {
      attempts.push(input);
    },
    finalizeSuccess: async (input) => {
      finalized.push(input);
      return true;
    },
    finalizeFailure: async (input) => {
      failures.push(input);
      return true;
    },
  };

  const service = new GatewayService(
    { resolveRoute: async () => ({ requestedModel: 'public-model', targets: [target] }) },
    {
      chatCompletion: async (...args) => {
        providerCalls.push(args);
        return providerResponse;
      },
    },
    requestLogs,
    {
      logRequest: (event) => telemetryEvents.push(event),
      logError: (event) => telemetryErrors.push(event),
    },
    { resolve: () => ({ apiKey: undefined, baseUrl: undefined, source: 'none' }) },
    {
      execute: async (targets, operation, options) => {
        const budgetMs = options?.budgetMs;
        const timeoutMs = budgetMs !== undefined
          ? Math.min(targets[0].timeoutMs, budgetMs)
          : targets[0].timeoutMs;
        return operation(targets[0], timeoutMs);
      },
    },
    // Unpriced model: cost is unknown, never zero.
    { calculate: async (input) => { costCalls.push(input); return null; } },
  );

  service.logger.error = (...args) => persistenceErrors.push(args);

  return {
    service,
    providerResponse,
    started,
    attempts,
    finalized,
    failures,
    telemetryEvents,
    telemetryErrors,
    providerCalls,
    persistenceErrors,
    costCalls,
  };
}

test('routes a request, records usage, and returns the trace ID', async () => {
  const state = createGatewayService();
  const response = await state.service.createCompletion(
    {
      model: 'public-model',
      messages: [{ role: 'user', content: 'hello' }],
      timeout: 500,
    },
    requestContext(),
  );

  assert.equal(response.trace_id, 'trace-1');
  assert.equal(response.choices[0].message.content, 'hello');
  assert.equal(state.providerCalls[0][1].model, 'upstream-model');
  assert.equal(state.providerCalls[0][1].timeout, undefined);
  assert.equal(state.providerCalls[0][2].timeoutMs, 500);

  // The PROCESSING row is created from the context, before routing.
  assert.equal(state.started.length, 1);
  assert.equal(state.started[0].requestId, 'request-1');
  assert.equal(state.started[0].userId, 'user-1');
  assert.equal(state.started[0].traceId, 'trace-1');

  assert.equal(state.finalized.length, 1);
  assert.equal(state.finalized[0].requestLogId, 'log-1');
  assert.equal(state.finalized[0].statusCode, 200);
  assert.equal(state.finalized[0].totalTokens, 5);
  assert.equal(state.failures.length, 0);

  // Exactly one usage event and no error event.
  assert.equal(state.telemetryEvents.length, 1);
  assert.equal(state.telemetryEvents[0].traceId, 'trace-1');
  assert.equal(state.telemetryErrors.length, 0);
  assert.equal(state.persistenceErrors.length, 0);
});

test('returns a provider success when request-log persistence fails', async () => {
  const state = createGatewayService({ failToPersist: true });
  const response = await state.service.createCompletion(
    {
      model: 'public-model',
      messages: [{ role: 'user', content: 'hello' }],
    },
    requestContext(),
  );

  assert.equal(response.id, 'completion-1');
  assert.equal(response.trace_id, 'trace-1');

  // The response is unaffected: one usage event, one reported failure.
  assert.equal(state.telemetryEvents.length, 1);
  assert.equal(state.persistenceErrors.length, 1);
  assert.match(state.persistenceErrors[0][0], /trace-1/);

  assert.equal(state.telemetryErrors.length, 1);
  assert.equal(state.telemetryErrors[0].errorCode, 'REQUEST_LOG_WRITE_FAILED');
  assert.equal(state.telemetryErrors[0].traceId, 'trace-1');
  assert.equal(state.telemetryErrors[0].statusCode, 0);
  assert.equal(
    state.telemetryErrors[0].errorMessage,
    'request-log.start: database unavailable',
  );

  // Nothing could be written without a parent row.
  assert.equal(state.started.length, 0);
  assert.equal(state.finalized.length, 0);
  assert.equal(state.failures.length, 0);
});
