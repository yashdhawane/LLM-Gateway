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
