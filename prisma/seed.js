const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');

const prisma = new PrismaClient();

async function main() {
  // MVP: one hardcoded admin account. Change this password before any real deployment.
  const adminPassword = 'admin123';
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const user = await prisma.user.upsert({
    where: { email: 'dev@local.test' },
    update: {
      role: 'ADMIN',
      passwordHash,
    },
    create: {
      email: 'dev@local.test',
      name: 'Dev Admin',
      passwordHash,
      role: 'ADMIN',
    },
  });

  const existingKey = await prisma.apiKey.findFirst({
    where: { userId: user.id, isActive: true },
  });

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
    console.log(`Seeded API key (store it now): ${rawKey}`);
  } else {
    console.log(`API key already exists for ${user.email} (prefix ${existingKey.prefix})`);
  }

  const models = [
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

  for (const model of models) {
    // Insert-only: re-seeding creates missing models but never mutates
    // existing rows (customize upstreamName via migration or manual edit).
    await prisma.model.upsert({
      where: { name: model.name },
      update: {},
      create: model,
    });
  }

  // Verified USD-per-million prices. Amounts stay strings so Prisma converts
  // them to Decimal(18, 8) without a float round-trip. Rows are append-only:
  // a price change is a new row with a later effectiveFrom, never an update.
  // Anthropic and Gemini are unverified and intentionally not seeded.
  const modelPrices = [
    { model: 'gpt-4o-mini', input: '0.15', output: '0.60' },
    { model: 'gpt-5-mini', input: '0.25', output: '2.00' },
    { model: 'gpt-5-nano', input: '0.05', output: '0.40' },
    { model: 'gpt-4.1-mini', input: '0.40', output: '1.60' },
  ];
  const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
  let seededPriceCount = 0;

  for (const price of modelPrices) {
    // findFirst + create: Postgres treats NULLs as distinct in the composite
    // unique, so a global row could otherwise be duplicated by a re-seed.
    const existingPrice = await prisma.modelPricing.findFirst({
      where: {
        provider: 'openai',
        model: price.model,
        userId: null,
        currency: 'USD',
        effectiveFrom,
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
        effectiveFrom,
        isActive: true,
      },
    });

    seededPriceCount += 1;
  }

  console.log(`Seeded ${seededPriceCount} model prices`);
  console.log(`Seeded user ${user.email} and ${models.length} models`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
