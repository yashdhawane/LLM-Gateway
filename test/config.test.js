const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv } = require('../dist/config/env.js');

const databaseUrl = 'postgresql://user:password@localhost:5432/llm_gateway';

test('validateEnv applies defaults for optional server settings', () => {
  const env = validateEnv({ DATABASE_URL: databaseUrl });

  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.PORT, 3000);
  assert.equal(env.LOG_LEVEL, 'info');
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('validateEnv coerces PORT and keeps a provided OpenAI key', () => {
  const env = validateEnv({
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'staging',
    PORT: '4100',
    LOG_LEVEL: 'debug',
    OPENAI_API_KEY: 'sk-test',
  });

  assert.equal(env.PORT, 4100);
  assert.equal(env.NODE_ENV, 'staging');
  assert.equal(env.LOG_LEVEL, 'debug');
  assert.equal(env.OPENAI_API_KEY, 'sk-test');
});

test('validateEnv treats an empty OpenAI key as missing', () => {
  const env = validateEnv({
    DATABASE_URL: databaseUrl,
    OPENAI_API_KEY: '   ',
  });

  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('validateEnv rejects a missing DATABASE_URL', () => {
  assert.throws(() => validateEnv({}), /DATABASE_URL/);
});

test('validateEnv rejects a non-Postgres DATABASE_URL', () => {
  assert.throws(
    () => validateEnv({ DATABASE_URL: 'file:./dev.db' }),
    /DATABASE_URL: must be a PostgreSQL connection string/,
  );
});

test('validateEnv rejects an out-of-range PORT', () => {
  assert.throws(
    () => validateEnv({ DATABASE_URL: databaseUrl, PORT: '70000' }),
    /PORT/,
  );
});

test('validateEnv drops variables that are not part of the schema', () => {
  const env = validateEnv({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: 'should-not-be-used',
  });

  assert.equal(env.JWT_SECRET, undefined);
});
