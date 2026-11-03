const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { seed } = require('../prisma/seed.js');

// The seed is a production operation (runbook step 5), so its contract is
// tested without a database: an in-memory Prisma fake records what the seed
// asks for, and re-running it must be a no-op for rows that already exist.
//
// Invariants under test:
//   1. a fresh database gets the default user, key, models and four prices;
//   2. a second run creates nothing and rewrites nothing (no new bcrypt salt);
//   3. an operator-edited user, model or price is never overwritten.

const EFFECTIVE_FROM = new Date('2026-01-01T00:00:00.000Z');

const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

function clone(row) {
  return { ...row };
}

function createFakePrisma({ users = [], apiKeys = [], models = [], modelPricing = [] } = {}) {
  const state = {
    users: users.map(clone),
    apiKeys: apiKeys.map(clone),
    models: models.map(clone),
    modelPricing: modelPricing.map(clone),
  };
  let nextId = 1;

  return {
    state,
    user: {
      async findUnique({ where }) {
        return state.users.find((row) => row.email === where.email) ?? null;
      },
      async upsert({ where, update, create }) {
        const existing = state.users.find((row) => row.email === where.email);

        if (existing) {
          Object.assign(existing, update);
          return clone(existing);
        }

        const row = { id: `user-${nextId++}`, ...create };
        state.users.push(row);
        return clone(row);
      },
    },
    apiKey: {
      async findFirst({ where }) {
        return (
          state.apiKeys.find(
            (row) =>
              row.userId === where.userId &&
              (where.isActive === undefined || row.isActive === where.isActive),
          ) ?? null
        );
      },
      async create({ data }) {
        const row = { id: `key-${nextId++}`, isActive: true, ...data };
        state.apiKeys.push(row);
        return clone(row);
      },
    },
    model: {
      async upsert({ where, update, create }) {
        const existing = state.models.find((row) => row.name === where.name);

        if (existing) {
          Object.assign(existing, update);
          return clone(existing);
        }

        const row = { id: `model-${nextId++}`, ...create };
        state.models.push(row);
        return clone(row);
      },
    },
    modelPricing: {
      async findFirst({ where }) {
        return (
          state.modelPricing.find(
            (row) =>
              row.provider === where.provider &&
              row.model === where.model &&
              (row.userId ?? null) === (where.userId ?? null) &&
              row.currency === where.currency &&
              row.effectiveFrom.getTime() === where.effectiveFrom.getTime(),
          ) ?? null
        );
      },
      async create({ data }) {
        const row = { id: `price-${nextId++}`, ...data };
        state.modelPricing.push(row);
        return clone(row);
      },
    },
    async $disconnect() {},
  };
}

function priceKey(row) {
  return `${row.provider}|${row.model}|${row.userId ?? 'global'}|${row.currency}|${row.effectiveFrom.toISOString()}`;
}

test('seeds the default user, API key, models and four prices on a fresh database', async () => {
  const prisma = createFakePrisma();

  const summary = await seed(prisma, { logger: silentLogger });

  assert.equal(prisma.state.users.length, 1);
  assert.equal(prisma.state.apiKeys.length, 1);
  assert.equal(prisma.state.models.length, 3);
  assert.equal(prisma.state.modelPricing.length, 4);
  assert.equal(summary.pricesSeeded, 4);
  assert.equal(summary.apiKeyCreated, true);

  const [user] = prisma.state.users;

  assert.equal(user.email, 'dev@local.test');
  assert.equal(user.name, 'Dev Admin');
  assert.equal(user.role, 'ADMIN');
  assert.equal(typeof user.passwordHash, 'string');
  assert.equal(await bcrypt.compare('admin123', user.passwordHash), true);

  assert.deepEqual(
    prisma.state.models.map((row) => row.name).sort(),
    ['claude-3-5-haiku-latest', 'gpt-4o-mini', 'mock'],
  );

  const prices = Object.fromEntries(
    prisma.state.modelPricing.map((row) => [
      row.model,
      [Number(row.inputPricePerMillion), Number(row.outputPricePerMillion)],
    ]),
  );

  assert.deepEqual(prices, {
    'gpt-4.1-mini': [0.4, 1.6],
    'gpt-4o-mini': [0.15, 0.6],
    'gpt-5-mini': [0.25, 2],
    'gpt-5-nano': [0.05, 0.4],
  });

  for (const row of prisma.state.modelPricing) {
    assert.equal(row.provider, 'openai');
    assert.equal(row.userId, null);
    assert.equal(row.currency, 'USD');
    assert.equal(row.isActive, true);
    assert.equal(row.effectiveFrom.getTime(), EFFECTIVE_FROM.getTime());
  }
});

test('re-running creates no duplicates and rewrites no existing row', async () => {
  const prisma = createFakePrisma();

  await seed(prisma, { logger: silentLogger });

  const userBefore = clone(prisma.state.users[0]);
  const keyBefore = clone(prisma.state.apiKeys[0]);
  const modelBefore = clone(prisma.state.models.find((row) => row.name === 'mock'));
  const priceBefore = clone(
    prisma.state.modelPricing.find((row) => row.model === 'gpt-4o-mini'),
  );

  const second = await seed(prisma, { logger: silentLogger });

  assert.equal(prisma.state.users.length, 1);
  assert.equal(prisma.state.apiKeys.length, 1);
  assert.equal(prisma.state.models.length, 3);
  assert.equal(prisma.state.modelPricing.length, 4);
  assert.equal(second.pricesSeeded, 0);
  assert.equal(second.apiKeyCreated, false);

  // A fresh bcrypt salt would change this hash on every run: exactly the
  // "unexpected overwrite" this test forbids.
  assert.equal(prisma.state.users[0].passwordHash, userBefore.passwordHash);
  assert.equal(prisma.state.users[0].role, userBefore.role);
  assert.equal(prisma.state.users[0].name, userBefore.name);

  assert.equal(prisma.state.apiKeys[0].key, keyBefore.key);
  assert.equal(prisma.state.apiKeys[0].prefix, keyBefore.prefix);

  assert.deepEqual(
    prisma.state.models.find((row) => row.name === 'mock'),
    modelBefore,
  );
  assert.deepEqual(
    prisma.state.modelPricing.find((row) => row.model === 'gpt-4o-mini'),
    priceBefore,
  );

  const uniquePrices = new Set(prisma.state.modelPricing.map(priceKey));
  assert.equal(uniquePrices.size, prisma.state.modelPricing.length);
});

test('never overwrites an existing user with the seed defaults', async () => {
  const prisma = createFakePrisma({
    users: [
      {
        id: 'user-existing',
        email: 'dev@local.test',
        name: 'Operator Override',
        role: 'OPERATOR',
        passwordHash: '$2a$10$existing-hash-that-must-survive',
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ],
  });

  await seed(prisma, { logger: silentLogger });

  const [user] = prisma.state.users;

  assert.equal(prisma.state.users.length, 1);
  assert.equal(user.id, 'user-existing');
  assert.equal(user.name, 'Operator Override');
  assert.equal(user.role, 'OPERATOR');
  assert.equal(user.passwordHash, '$2a$10$existing-hash-that-must-survive');

  // The seed still supplies everything that was genuinely missing.
  assert.equal(prisma.state.modelPricing.length, 4);
  assert.equal(prisma.state.models.length, 3);
  assert.equal(prisma.state.apiKeys.length, 1);
});

test('never overwrites operator-edited model and price rows', async () => {
  const prisma = createFakePrisma({
    users: [
      {
        id: 'user-existing',
        email: 'dev@local.test',
        name: 'Dev Admin',
        role: 'ADMIN',
        passwordHash: '$2a$10$existing',
        createdAt: EFFECTIVE_FROM,
      },
    ],
    models: [
      {
        id: 'model-custom',
        name: 'mock',
        provider: 'mock',
        upstreamName: 'custom-upstream',
        baseUrl: 'https://upstream.invalid',
        fallbackModels: ['fallback'],
        maxRetries: 7,
        cooldownMs: 999,
      },
    ],
    modelPricing: [
      {
        id: 'price-custom',
        provider: 'openai',
        model: 'gpt-4o-mini',
        userId: null,
        currency: 'USD',
        inputPricePerMillion: '9.99',
        outputPricePerMillion: '9.99',
        effectiveFrom: EFFECTIVE_FROM,
        isActive: false,
      },
    ],
  });

  await seed(prisma, { logger: silentLogger });

  const model = prisma.state.models.find((row) => row.name === 'mock');
  const price = prisma.state.modelPricing.find(
    (row) => row.model === 'gpt-4o-mini',
  );

  assert.equal(prisma.state.models.length, 3);
  assert.deepEqual(model, {
    id: 'model-custom',
    name: 'mock',
    provider: 'mock',
    upstreamName: 'custom-upstream',
    baseUrl: 'https://upstream.invalid',
    fallbackModels: ['fallback'],
    maxRetries: 7,
    cooldownMs: 999,
  });

  // Four rows total: the existing one is kept verbatim, the other three added.
  assert.equal(prisma.state.modelPricing.length, 4);
  assert.equal(price.id, 'price-custom');
  assert.equal(String(price.inputPricePerMillion), '9.99');
  assert.equal(String(price.outputPricePerMillion), '9.99');
  assert.equal(price.isActive, false);

  const gpt4oMiniRows = prisma.state.modelPricing.filter(
    (row) => row.model === 'gpt-4o-mini',
  );
  assert.equal(gpt4oMiniRows.length, 1);
});
