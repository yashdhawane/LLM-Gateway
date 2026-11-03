const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RouterService,
  MAX_PROVIDER_TIMEOUT_MS,
} = require('../dist/modules/router/router.service.js');

const MINUTE = 60 * 1000;

function model(overrides = {}) {
  return {
    id: 'model-1',
    name: 'public-model',
    provider: ' OpenAI ',
    upstreamName: null,
    baseUrl: null,
    timeoutMs: 30_000,
    maxRetries: 0,
    cooldownMs: 30_000,
    fallbackModels: [],
    isActive: true,
    ...overrides,
  };
}

function fakePrisma(record) {
  return {
    model: {
      findUnique: async () => record,
      findMany: async () => [],
    },
  };
}

test('a configured provider timeout is capped at a sensible maximum', async () => {
  const service = new RouterService(
    fakePrisma(model({ timeoutMs: 24 * 60 * MINUTE })),
  );

  const decision = await service.resolveRoute('public-model');

  assert.equal(MAX_PROVIDER_TIMEOUT_MS, 5 * MINUTE);
  assert.equal(decision.targets[0].timeoutMs, MAX_PROVIDER_TIMEOUT_MS);
});

test('the provider timeout keeps its existing lower bound', async () => {
  const service = new RouterService(fakePrisma(model({ timeoutMs: 0 })));

  const decision = await service.resolveRoute('public-model');

  assert.equal(decision.targets[0].timeoutMs, 1);
});
