const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv } = require('../dist/config/env.js');

const databaseUrl = 'postgresql://user:password@localhost:5432/llm_gateway';
const jwtSecret = 'test-jwt-secret-that-is-long-enough-123456';

test('validateEnv applies defaults for optional server settings', () => {
  const env = validateEnv({ DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret });

  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.PORT, 4000);
  assert.equal(env.JWT_EXPIRES_IN, '7d');
  assert.equal(env.LOG_LEVEL, 'info');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
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
    ANTHROPIC_API_KEY: 'sk-ant-test',
  });

  assert.equal(env.PORT, 4100);
  assert.equal(env.NODE_ENV, 'staging');
  assert.equal(env.JWT_EXPIRES_IN, '1h');
  assert.equal(env.LOG_LEVEL, 'debug');
  assert.equal(env.OPENAI_API_KEY, 'sk-test');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
});

test('validateEnv treats an empty OpenAI key as missing', () => {
  const env = validateEnv({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    OPENAI_API_KEY: '   ',
  });

  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('validateEnv treats an empty Anthropic key as missing', () => {
  const env = validateEnv({
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    ANTHROPIC_API_KEY: '   ',
  });

  assert.equal(env.ANTHROPIC_API_KEY, undefined);
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

test('validateEnv keeps Swagger disabled unless a local .env opts in', () => {
  const base = { DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret };

  assert.equal(validateEnv(base).SWAGGER_ENABLED, false);
  assert.equal(
    validateEnv({ ...base, SWAGGER_ENABLED: 'false' }).SWAGGER_ENABLED,
    false,
  );
  assert.equal(
    validateEnv({ ...base, SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED,
    true,
  );
});

test('validateEnv rejects a Swagger flag that is not true or false', () => {
  assert.throws(
    () =>
      validateEnv({
        DATABASE_URL: databaseUrl,
        JWT_SECRET: jwtSecret,
        SWAGGER_ENABLED: 'yes',
      }),
    /SWAGGER_ENABLED/,
  );
});

// --- CORS origins ---------------------------------------------------------
//
// The browser only gets to call this API when the origin is on the list, and
// the credentials flag means a wildcard would hand any site the user's session.
// These tests pin the list's defaults, its parsing and the shapes it refuses.

const corsBase = { DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret };

test('validateEnv allows the Next.js dev server by default in development', () => {
  const env = validateEnv(corsBase);

  assert.deepEqual(env.CORS_ORIGINS, ['http://localhost:3000']);
});

test('validateEnv allows no browser origin by default outside development', () => {
  for (const NODE_ENV of ['staging', 'production']) {
    const env = validateEnv({ ...corsBase, NODE_ENV });

    assert.deepEqual(env.CORS_ORIGINS, [], NODE_ENV);
  }
});

test('validateEnv splits, trims and normalises an explicit origin list', () => {
  const env = validateEnv({
    ...corsBase,
    CORS_ORIGINS:
      ' https://app.example.com , HTTP://LocalHost:3000/ , , https://preview.example.com ',
  });

  assert.deepEqual(env.CORS_ORIGINS, [
    'https://app.example.com',
    'http://localhost:3000',
    'https://preview.example.com',
  ]);
});

test('validateEnv rejects an origin that carries a path or a query', () => {
  for (const value of [
    'https://app.example.com/api',
    'https://app.example.com/?next=1',
  ]) {
    assert.throws(
      () => validateEnv({ ...corsBase, CORS_ORIGINS: value }),
      /CORS_ORIGINS/,
      value,
    );
  }
});

test('validateEnv rejects an entry that is not an absolute http origin', () => {
  for (const value of ['localhost:3000', 'ftp://app.example.com', 'app.example.com']) {
    assert.throws(
      () => validateEnv({ ...corsBase, CORS_ORIGINS: value }),
      /CORS_ORIGINS/,
      value,
    );
  }
});

test('validateEnv rejects a wildcard origin because credentials are allowed', () => {
  assert.throws(
    () => validateEnv({ ...corsBase, CORS_ORIGINS: '*' }),
    /CORS_ORIGINS/,
  );
});
