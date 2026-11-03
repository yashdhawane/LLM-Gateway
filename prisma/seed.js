const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');

const DEFAULT_USER_EMAIL = 'dev@local.test';

// One hardcoded admin account for local development. Change the password (or
// the account) before any real deployment.
const DEFAULT_USER = {
  email: DEFAULT_USER_EMAIL,
  name: 'Dev Admin',
  role: 'ADMIN',
};
const DEFAULT_PASSWORD = 'admin123';

const MODELS = [
  {
    name: 'mock',
    provider: 'mock',
    upstreamName: 'mock',
    baseUrl: null,
    fallbackModels: [],
    maxRetries: 0,
    cooldownMs: 30000,
  },
  {
    name: 'gpt-4o-mini',
    provider: 'openai',
    upstreamName: 'gpt-4o-mini',
    baseUrl: null,
    fallbackModels: [],
    maxRetries: 0,
    cooldownMs: 30000,
  },
  {
    name: 'claude-3-5-haiku-latest',
    provider: 'anthropic',
    upstreamName: 'claude-3-5-haiku-latest',
    baseUrl: null,
    fallbackModels: [],
    maxRetries: 0,
    cooldownMs: 30000,
  },
];

// Verified USD-per-million prices. Amounts stay strings so Prisma converts
// them to Decimal(18, 8) without a float round-trip. Rows are append-only:
// a price change is a new row with a later effectiveFrom, never an update.
// Anthropic and Gemini are unverified and intentionally not seeded.
const MODEL_PRICES = [
  { model: 'gpt-4o-mini', input: '0.15', output: '0.60' },
  { model: 'gpt-5-mini', input: '0.25', output: '2.00' },
  { model: 'gpt-5-nano', input: '0.05', output: '0.40' },
  { model: 'gpt-4.1-mini', input: '0.40', output: '1.60' },
];
const PRICE_EFFECTIVE_FROM = new Date('2026-01-01T00:00:00.000Z');

/**
 * Idempotent seed: creates what is missing, never rewrites what exists.
 *
 * - The user upsert has an empty `update`, so a re-run cannot rotate the
 *   password hash (a fresh bcrypt salt) or demote an operator-edited role.
 * - Model upserts are insert-only for the same reason.
 * - Global prices are findFirst-then-create: Postgres treats NULLs as
 *   distinct in the composite unique, so an upsert could duplicate them.
 *
 * Takes a Prisma client so tests can run this without a database.
 */
async function seed(prisma, { logger = console } = {}) {
  const user = await prisma.user.upsert({
    where: { email: DEFAULT_USER.email },
    // Create-only. An existing user keeps its passwordHash, role and name.
    update: {},
    create: {
      ...DEFAULT_USER,
      passwordHash: await bcrypt.hash(DEFAULT_PASSWORD, 10),
    },
  });

  const existingKey = await prisma.apiKey.findFirst({
    where: { userId: user.id, isActive: true },
  });

  let apiKeyCreated = false;

  if (!existingKey) {
    const rawKey = `lg_${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.create({
      data: {
        key: await bcrypt.hash(rawKey, 10),
        prefix: rawKey.substring(0, 11),
        name: 'dev',
        ownerId: user.id,
        ownerType: 'USER',
        userId: user.id,
      },
    });
    logger.log(`Seeded API key (store it now): ${rawKey}`);
    apiKeyCreated = true;
  } else {
    logger.log(
      `API key already exists for ${user.email} (prefix ${existingKey.prefix})`,
    );
  }

  for (const model of MODELS) {
    // Insert-only: re-seeding creates missing models but never mutates
    // existing rows (customize upstreamName via migration or manual edit).
    await prisma.model.upsert({
      where: { name: model.name },
      update: {},
      create: model,
    });
  }

  let pricesSeeded = 0;

  for (const price of MODEL_PRICES) {
    // findFirst + create: Postgres treats NULLs as distinct in the composite
    // unique, so a global row could otherwise be duplicated by a re-seed.
    const existingPrice = await prisma.modelPricing.findFirst({
      where: {
        provider: 'openai',
        model: price.model,
        userId: null,
        currency: 'USD',
        effectiveFrom: PRICE_EFFECTIVE_FROM,
      },
    });

    if (existingPrice) {
      continue;
    }

    await prisma.modelPricing.create({
      data: {
        provider: 'openai',
        model: price.model,
        userId: null,
        currency: 'USD',
        inputPricePerMillion: price.input,
        outputPricePerMillion: price.output,
        effectiveFrom: PRICE_EFFECTIVE_FROM,
        isActive: true,
      },
    });

    pricesSeeded += 1;
  }

  logger.log(`Seeded ${pricesSeeded} model prices`);
  logger.log(`Seeded user ${user.email} and ${MODELS.length} models`);

  return {
    user: { id: user.id, email: user.email },
    apiKeyCreated,
    models: MODELS.length,
    pricesSeeded,
  };
}

async function main() {
  const prisma = new PrismaClient();

  try {
    await seed(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { seed };
