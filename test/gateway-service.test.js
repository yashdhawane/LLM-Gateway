const test = require('node:test');
const assert = require('node:assert/strict');
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

function createGatewayService({ failToPersist = false } = {}) {
  const persistedLogs = [];
  const telemetryEvents = [];
  const providerCalls = [];
  const persistenceErrors = [];

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

  const service = new GatewayService(
    { resolveRoute: async () => ({ requestedModel: 'public-model', targets: [target] }) },
    {
      chatCompletion: async (...args) => {
        providerCalls.push(args);
        return providerResponse;
      },
    },
    {
      requestLog: {
        create: async ({ data }) => {
          if (failToPersist) {
            throw new Error('database unavailable');
          }
          persistedLogs.push(data);
        },
      },
    },
    { logRequest: (event) => telemetryEvents.push(event) },
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
  );

  service.logger.error = (...args) => persistenceErrors.push(args);

  return {
    service,
    providerResponse,
    persistedLogs,
    telemetryEvents,
    providerCalls,
    persistenceErrors,
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
    { user, traceId: 'trace-1', requestId: 'request-1' },
  );

  assert.equal(response.trace_id, 'trace-1');
  assert.equal(response.choices[0].message.content, 'hello');
  assert.equal(state.providerCalls[0][1].model, 'upstream-model');
  assert.equal(state.providerCalls[0][1].timeout, undefined);
  assert.equal(state.providerCalls[0][2].timeoutMs, 500);
  assert.equal(state.persistedLogs[0].requestId, 'request-1');
  assert.equal(state.persistedLogs[0].totalTokens, 5);
  assert.equal(state.telemetryEvents[0].traceId, 'trace-1');
});

test('returns a provider success when request-log persistence fails', async () => {
  const state = createGatewayService({ failToPersist: true });
  const response = await state.service.createCompletion(
    {
      model: 'public-model',
      messages: [{ role: 'user', content: 'hello' }],
    },
    { user, traceId: 'trace-1', requestId: 'request-1' },
  );

  assert.equal(response.id, 'completion-1');
  assert.equal(state.telemetryEvents.length, 1);
  assert.equal(state.persistenceErrors.length, 1);
  assert.match(state.persistenceErrors[0][0], /trace-1/);
});
