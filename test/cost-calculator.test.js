const test = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
const { PricingService } = require('../dist/modules/pricing/pricing.service.js');
const {
  calculateCost,
  CostCalculator,
} = require('../dist/modules/pricing/cost-calculator.js');

// In-memory only: no database, no Nest container. Pricing rows are plain
// objects with the Decimal columns Prisma would hydrate.
function priceRow({
  id,
  userId = null,
  input,
  output,
  effectiveFrom,
  provider = 'openai',
  model = 'gpt-4o-mini',
  currency = 'USD',
}) {
  return {
    id,
    provider,
    model,
    userId,
    currency,
    inputPricePerMillion: new Prisma.Decimal(input),
    outputPricePerMillion: new Prisma.Decimal(output),
    effectiveFrom: new Date(effectiveFrom),
    effectiveTo: null,
    isActive: true,
    createdAt: new Date(effectiveFrom),
    updatedAt: new Date(effectiveFrom),
  };
}

function fakePrisma(rows) {
  const calls = [];

  return {
    calls,
    modelPricing: {
      findMany: async (args) => {
        calls.push(args);
        return rows;
      },
    },
  };
}

function snapshot({ pricingId = 'price-1', input, output, currency = 'USD' }) {
  return {
    pricingId,
    currency,
    inputPricePerMillion: new Prisma.Decimal(input),
    outputPricePerMillion: new Prisma.Decimal(output),
  };
}

const AT = new Date('2026-11-02T10:00:00.000Z');

test('prices a known usage at ten decimal places', async () => {
  const prisma = fakePrisma([
    priceRow({
      id: 'price-global',
      input: '0.15',
      output: '0.60',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    }),
  ]);
  const pricing = new PricingService(prisma);

  const resolved = await pricing.resolvePricing({
    provider: 'openai',
    model: 'gpt-4o-mini',
    userId: 'user-1',
    at: AT,
  });

  const cost = calculateCost({
    promptTokens: 1000,
    completionTokens: 500,
    pricing: resolved,
  });

  assert.equal(cost.pricingId, 'price-global');
  assert.equal(cost.currency, 'USD');
  assert.equal(cost.inputCost.toString(), '0.00015');
  assert.equal(cost.outputCost.toString(), '0.0003');
  assert.equal(cost.totalCost.toString(), '0.00045');

  // The query is scoped exactly as §3.3 requires.
  assert.deepEqual(prisma.calls[0].where, {
    isActive: true,
    provider: 'openai',
    model: 'gpt-4o-mini',
    currency: 'USD',
    effectiveFrom: { lte: AT },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: AT } }],
    AND: [{ OR: [{ userId: 'user-1' }, { userId: null }] }],
  });

  // Cached within the TTL; clearCache() forces a fresh lookup.
  await pricing.resolvePricing({
    provider: 'openai',
    model: 'gpt-4o-mini',
    userId: 'user-1',
    at: AT,
  });
  assert.equal(prisma.calls.length, 1);
  pricing.clearCache();
  await pricing.resolvePricing({
    provider: 'openai',
    model: 'gpt-4o-mini',
    userId: 'user-1',
    at: AT,
  });
  assert.equal(prisma.calls.length, 2);

  // A user-scoped row beats a newer global row: the tier rule is applied in
  // memory, because Postgres sorts NULLS FIRST on a DESC userId ordering.
  const tiered = new PricingService(
    fakePrisma([
      priceRow({
        id: 'price-global-newer',
        input: '0.90',
        output: '0.90',
        effectiveFrom: '2026-06-01T00:00:00.000Z',
      }),
      priceRow({
        id: 'price-user',
        userId: 'user-1',
        input: '0.15',
        output: '0.60',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      }),
    ]),
  );

  const userSnapshot = await tiered.resolvePricing({
    provider: 'openai',
    model: 'gpt-4o-mini',
    userId: 'user-1',
    at: AT,
  });

  assert.equal(userSnapshot.pricingId, 'price-user');
  assert.equal(userSnapshot.inputPricePerMillion.toString(), '0.15');
  assert.equal(
    calculateCost({
      promptTokens: 1000,
      completionTokens: 500,
      pricing: userSnapshot,
    }).totalCost.toString(),
    '0.00045',
  );
});

test('returns null when pricing is unknown', async () => {
  const prisma = fakePrisma([]);
  const pricing = new PricingService(prisma);
  const calculator = new CostCalculator(pricing);
  const request = {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
    userId: 'user-1',
    at: AT,
    promptTokens: 10,
    completionTokens: 5,
  };

  assert.equal(await pricing.resolvePricing(request), null);
  assert.equal(calculateCost({ promptTokens: 10, completionTokens: 5, pricing: null }), null);
  assert.equal(await calculator.calculate(request), null);

  // A miss is never cached: a price row seeded after boot is visible at once.
  assert.equal(prisma.calls.length, 2);
});

test('returns null cost when usage is missing', () => {
  const pricing = snapshot({ input: '0.15', output: '0.60' });

  const missingCompletion = calculateCost({
    promptTokens: 1000,
    completionTokens: null,
    pricing,
  });

  assert.equal(missingCompletion.inputCost.toString(), '0.00015');
  assert.equal(missingCompletion.outputCost, null);
  assert.equal(missingCompletion.totalCost, null);

  const missingPrompt = calculateCost({
    completionTokens: 500,
    pricing,
  });

  assert.equal(missingPrompt.inputCost, null);
  assert.equal(missingPrompt.outputCost.toString(), '0.0003');
  assert.equal(missingPrompt.totalCost, null);

  const missingBoth = calculateCost({ pricing });

  assert.equal(missingBoth.inputCost, null);
  assert.equal(missingBoth.outputCost, null);
  assert.equal(missingBoth.totalCost, null);
});

test('charges zero for zero tokens', () => {
  const cost = calculateCost({
    promptTokens: 0,
    completionTokens: 0,
    pricing: snapshot({ input: '0.15', output: '0.60' }),
  });

  assert.equal(cost.inputCost.toString(), '0');
  assert.equal(cost.outputCost.toString(), '0');
  assert.equal(cost.totalCost.toString(), '0');
});

test('returns null instead of throwing when the pricing lookup fails', async () => {
  const explodingPricing = {
    resolvePricing: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  };

  assert.equal(
    await new CostCalculator(explodingPricing).calculate({
      provider: 'openai',
      model: 'gpt-4o-mini',
      promptTokens: 1000,
      completionTokens: 500,
    }),
    null,
  );

  const brokenPrisma = {
    modelPricing: {
      findMany: async () => {
        throw new Error('P1001: can\'t reach database server');
      },
    },
  };

  assert.equal(
    await new CostCalculator(new PricingService(brokenPrisma)).calculate({
      provider: 'openai',
      model: 'gpt-4o-mini',
      promptTokens: 1000,
      completionTokens: 500,
    }),
    null,
  );
});
