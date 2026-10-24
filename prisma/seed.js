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
    { name: 'mock', provider: 'mock', baseUrl: null },
    { name: 'gpt-4o-mini', provider: 'openai', baseUrl: null },
  ];

  for (const model of models) {
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
