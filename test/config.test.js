const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv } = require('../dist/config/env.js');

const databaseUrl = 'postgresql://user:password@localhost:5432/llm_gateway';
const jwtSecret = 'test-jwt-secret-that-is-long-enough-123456';

test('validateEnv applies defaults for optional server settings', () => {
  const env = validateEnv({ DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret });

  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.PORT, 3000);
  assert.equal(env.JWT_EXPIRES_IN, '7d');
  assert.equal(env.LOG_LEVEL, 'info');
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('validateEnv coerces PORT and keeps provided auth/provider settings', () => {
  const env = validateEnv({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: '1h',
    NODE_ENV: 'staging',
    PORT: '4100',
    LOG_LEVEL: 'debug',
    OPENAI_API_KEY: 'sk-test',
  });

  assert.equal(env.PORT, 4100);
  assert.equal(env.NODE_ENV, 'staging');
  assert.equal(env.JWT_EXPIRES_IN, '1h');
  assert.equal(env.LOG_LEVEL, 'debug');
  assert.equal(env.OPENAI_API_KEY, 'sk-test');
});

test('validateEnv treats an empty OpenAI key as missing', () => {
  const env = validateEnv({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    OPENAI_API_KEY: '   ',
  });

  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('validateEnv rejects a missing DATABASE_URL', () => {
  assert.throws(() => validateEnv({ JWT_SECRET: jwtSecret }), /DATABASE_URL/);
});

test('validateEnv rejects a non-Postgres DATABASE_URL', () => {
  assert.throws(
    () =>
      validateEnv({
        DATABASE_URL: 'file:./dev.db',
        JWT_SECRET: jwtSecret,
      }),
    /DATABASE_URL: must be a PostgreSQL connection string/,
  );
});

test('validateEnv rejects an out-of-range PORT', () => {
  assert.throws(
    () =>
      validateEnv({
        DATABASE_URL: databaseUrl,
        JWT_SECRET: jwtSecret,
        PORT: '70000',
      }),
    /PORT/,
  );
});

test('validateEnv rejects a missing JWT secret', () => {
  assert.throws(
    () => validateEnv({ DATABASE_URL: databaseUrl }),
    /JWT_SECRET/,
  );
});

test('validateEnv rejects a short JWT secret', () => {
  assert.throws(
    () => validateEnv({ DATABASE_URL: databaseUrl, JWT_SECRET: 'short' }),
    /JWT_SECRET: must be at least 32 characters/,
  );
});

test('validateEnv drops variables that are not part of the schema', () => {
  const env = validateEnv({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    LEGACY_SETTING: 'should-not-be-used',
  });

  assert.equal(env.LEGACY_SETTING, undefined);
  assert.equal(env.JWT_SECRET, jwtSecret);
});
