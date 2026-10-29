const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProviderError,
} = require('../dist/modules/providers/base.provider.js');
const {
  ResilienceService,
} = require('../dist/modules/providers/resilience.service.js');

function target(overrides = {}) {
  return {
    modelId: overrides.modelId ?? 'model-1',
    modelName: overrides.modelName ?? 'primary',
    upstreamModel: overrides.upstreamModel ?? 'primary-upstream',
    provider: overrides.provider ?? 'mock',
    baseUrl: undefined,
    timeoutMs: overrides.timeoutMs ?? 1000,
    maxRetries: overrides.maxRetries ?? 0,
    cooldownMs: overrides.cooldownMs ?? 30000,
  };
}

function createService() {
  const service = new ResilienceService();
  service.logger.warn = () => {};
  return service;
}

function remainingCooldownMs(service, key) {
  const until = service.cooldowns.get(key);
  return until ? until - Date.now() : null;
}

test('retries a retryable provider failure and then succeeds', async () => {
  const service = createService();
  let calls = 0;

  const result = await service.execute(
    [target({ maxRetries: 2 })],
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new ProviderError('PROVIDER_TIMEOUT', 'timed out');
      }
      return 'ok';
    },
  );

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('falls back to the next target after a provider failure', async () => {
  const service = createService();
  const calls = [];

  const result = await service.execute(
    [
      target({ modelId: 'primary-id', modelName: 'primary' }),
      target({ modelId: 'fallback-id', modelName: 'fallback' }),
    ],
    async (selected) => {
      calls.push(selected.modelName);
      if (selected.modelName === 'primary') {
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'down');
      }
      return selected.modelName;
    },
  );

  assert.equal(result, 'fallback');
  assert.deepEqual(calls, ['primary', 'fallback']);
});

test('falls back when a provider is not configured', async () => {
  const service = createService();
  const calls = [];

  const result = await service.execute(
    [
      target({ modelId: 'primary-id', modelName: 'primary' }),
      target({ modelId: 'fallback-id', modelName: 'fallback' }),
    ],
    async (selected) => {
      calls.push(selected.modelName);
      if (selected.modelName === 'primary') {
        throw new ProviderError(
          'PROVIDER_NOT_CONFIGURED',
          'missing key',
        );
      }
      return selected.modelName;
    },
  );

  assert.equal(result, 'fallback');
  assert.deepEqual(calls, ['primary', 'fallback']);
});

test('does not retry or fall back on a provider bad request', async () => {
  const service = createService();
  let fallbackCalls = 0;

  await assert.rejects(
    () =>
      service.execute(
        [
          target({ modelId: 'primary-id', modelName: 'primary' }),
          target({ modelId: 'fallback-id', modelName: 'fallback' }),
        ],
        async (selected) => {
          if (selected.modelName === 'fallback') {
            fallbackCalls += 1;
            return 'fallback';
          }
          throw new ProviderError('PROVIDER_BAD_REQUEST', 'invalid');
        },
      ),
    (error) => error instanceof ProviderError
      && error.code === 'PROVIDER_BAD_REQUEST',
  );

  assert.equal(fallbackCalls, 0);
});

test('fails fast when every route is cooling down', async () => {
  const service = createService();
  const targets = [target({ modelId: 'only-id', modelName: 'only' })];
  let calls = 0;

  const operation = async () => {
    calls += 1;
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'down');
  };

  await assert.rejects(() => service.execute(targets, operation));
  await assert.rejects(
    () => service.execute(targets, operation),
    (error) =>
      error instanceof ProviderError
      && error.code === 'PROVIDER_UNAVAILABLE'
      && /temporarily unavailable/.test(error.message),
  );

  assert.equal(calls, 1);
});

test('cooldown skips a failed route on the next request', async () => {
  const service = createService();
  const targets = [
    target({ modelId: 'primary-id', modelName: 'primary' }),
    target({ modelId: 'fallback-id', modelName: 'fallback' }),
  ];
  const calls = [];

  const operation = async (selected) => {
    calls.push(selected.modelName);
    if (selected.modelName === 'primary') {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'down');
    }
    return 'fallback';
  };

  await service.execute(targets, operation);
  const second = await service.execute(targets, operation);

  assert.equal(second, 'fallback');
  assert.deepEqual(calls, ['primary', 'fallback', 'fallback']);
});

test('does not open cooldown while an immediate retry is still pending', async () => {
  const service = createService();
  const targets = [target({ modelId: 'only-id', modelName: 'only', maxRetries: 1 })];
  let attempts = 0;

  const pending = service.execute(targets, async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new ProviderError('PROVIDER_TIMEOUT', 'timed out');
    }
    return 'ok';
  });

  // Probe the same route during the 100ms backoff window that precedes the
  // immediate retry. While the retry is pending, the route must stay usable.
  const probe = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return service.execute(targets, async () => 'probe-ok');
  })();

  const result = await pending;
  const probeResult = await probe;

  assert.equal(result, 'ok');
  assert.equal(probeResult, 'probe-ok');
});

test('opens cooldown only when the target is abandoned', async () => {
  const service = createService();
  const targets = [
    target({ modelId: 'primary-id', modelName: 'primary', maxRetries: 1, cooldownMs: 30000 }),
    target({ modelId: 'fallback-id', modelName: 'fallback' }),
  ];
  let primaryCalls = 0;

  const operation = async (selected) => {
    if (selected.modelName === 'primary') {
      primaryCalls += 1;
      throw new ProviderError('PROVIDER_TIMEOUT', 'timed out');
    }
    return 'fallback';
  };

  const result = await service.execute(targets, operation);

  // Both attempts of the primary target ran and it was then abandoned.
  assert.equal(primaryCalls, 2);
  assert.equal(result, 'fallback');

  const remaining = remainingCooldownMs(service, 'mock:primary-id:primary');
  // First abandoned failure escalates to 1s, never the full 30s cooldownMs.
  assert.ok(
    remaining !== null && remaining <= 1000 && remaining > 0,
    `expected a <=1000ms cooldown, got ${remaining}ms`,
  );
});

test('first-failure cooldown is capped below cooldownMs', async () => {
  const service = createService();
  const targets = [
    target({ modelId: 'only-id', modelName: 'only', cooldownMs: 30000 }),
  ];

  await assert.rejects(
    () =>
      service.execute(targets, async () => {
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'down');
      }),
  );

  const remaining = remainingCooldownMs(service, 'mock:only-id:only');
  assert.ok(
    remaining !== null && remaining <= 1000 && remaining > 0,
    `expected a <=1000ms first-failure cooldown, got ${remaining}ms`,
  );
});

test('consecutive abandoned failures escalate until cooldownMs caps the step', async () => {
  const service = createService();
  const targets = [
    target({ modelId: 'only-id', modelName: 'only', cooldownMs: 30000 }),
  ];
  const operation = async () => {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'down');
  };

  // First abandoned failure: 1000ms step.
  await assert.rejects(() => service.execute(targets, operation));
  const firstRemaining = remainingCooldownMs(service, 'mock:only-id:only');
  assert.ok(
    firstRemaining !== null && firstRemaining <= 1000 && firstRemaining > 0,
    `expected ~1000ms first step, got ${firstRemaining}ms`,
  );

  // Second abandoned failure: 2000ms step.
  service.cooldowns.set('mock:only-id:only', Date.now() - 1);
  await assert.rejects(() => service.execute(targets, operation));
  const secondRemaining = remainingCooldownMs(service, 'mock:only-id:only');
  assert.ok(
    secondRemaining !== null && secondRemaining <= 2000 && secondRemaining > 0,
    `expected ~2000ms second step, got ${secondRemaining}ms`,
  );

  // Third abandoned failure: 4000ms step.
  service.cooldowns.set('mock:only-id:only', Date.now() - 1);
  await assert.rejects(() => service.execute(targets, operation));
  const thirdRemaining = remainingCooldownMs(service, 'mock:only-id:only');
  assert.ok(
    thirdRemaining !== null && thirdRemaining <= 4000 && thirdRemaining > 0,
    `expected ~4000ms third step, got ${thirdRemaining}ms`,
  );

  // Later failures keep escalating until the configured cooldownMs caps them:
  // 8000ms, 16000ms, then 32000ms clamped to the 30000ms cap.
  for (let i = 4; i <= 6; i += 1) {
    service.cooldowns.set('mock:only-id:only', Date.now() - 1);
    await assert.rejects(() => service.execute(targets, operation));
    const remaining = remainingCooldownMs(service, 'mock:only-id:only');
    assert.ok(
      remaining !== null && remaining > 0,
      `expected a cooldown at step ${i}, got ${remaining}ms`,
    );
  }
  const capped = remainingCooldownMs(service, 'mock:only-id:only');
  assert.ok(
    capped !== null && capped <= 30000 && capped > 29000,
    `expected the 30000ms cap at step 6, got ${capped}ms`,
  );
});

test('success resets the consecutive-failure counter', async () => {
  const service = createService();
  const targets = [
    target({ modelId: 'only-id', modelName: 'only', maxRetries: 1, cooldownMs: 30000 }),
  ];
  let calls = 0;

  // Round 1: fail once, retry succeeds — the failure counter must reset.
  const first = await service.execute(targets, async () => {
    calls += 1;
    if (calls < 2) {
      throw new ProviderError('PROVIDER_TIMEOUT', 'timed out');
    }
    return 'ok';
  });
  assert.equal(first, 'ok');

  // Round 2: abandon the route. With a reset counter this is a first failure
  // (~1000ms step); a stale counter would have produced ~2000ms.
  await assert.rejects(
    () =>
      service.execute(targets, async () => {
        throw new ProviderError('PROVIDER_TIMEOUT', 'timed out');
      }),
  );

  const remaining = remainingCooldownMs(service, 'mock:only-id:only');
  assert.ok(
    remaining !== null && remaining <= 1000 && remaining > 0,
    `expected a reset first-failure step (~1000ms), got ${remaining}ms`,
  );
});

test('budget exhaustion before a retry prevents further attempts', async () => {
  const service = createService();
  const timeouts = [];
  let attempts = 0;

  await assert.rejects(
    () =>
      service.execute(
        [target({ maxRetries: 1 })],
        async (selected, timeoutMs) => {
          attempts += 1;
          timeouts.push(timeoutMs);
          await new Promise((resolve) => setTimeout(resolve, 80));
          throw new ProviderError('PROVIDER_TIMEOUT', 'timed out');
        },
        { budgetMs: 50 },
      ),
    (error) =>
      error instanceof ProviderError
      && error.code === 'PROVIDER_TIMEOUT'
      && /budget exhausted/i.test(error.message),
  );

  assert.equal(attempts, 1);
  assert.deepEqual(timeouts, [50]);
});

test('a client budget clamps the effective timeout; without one target.timeoutMs is used', async () => {
  const service = createService();

  await service.execute(
    [target({ timeoutMs: 1000 })],
    async (selected, timeoutMs) => {
      assert.equal(timeoutMs, 500);
      return 'ok';
    },
    { budgetMs: 500 },
  );

  await service.execute(
    [target({ timeoutMs: 1000 })],
    async (selected, timeoutMs) => {
      assert.equal(timeoutMs, 1000);
      return 'ok';
    },
  );
});
