const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// `contracts/openapi.json` is the machine-readable half of the API contract
// that the frontend repository generates its TypeScript types from. It is
// produced by `npm run contract:export` and committed, so these tests are a
// guard against a stale or empty file: adding a route without regenerating
// makes the expected-path assertion fail.
const CONTRACT_PATH = path.join(__dirname, '..', 'contracts', 'openapi.json');

// Kept deliberately explicit rather than derived from the source: the point is
// to notice when the published contract and the routes drift apart, which a
// derivation would hide by construction.
const EXPECTED_PATHS = [
  '/api/v1/admin/insights',
  '/api/v1/auth/keys',
  '/api/v1/auth/keys/{id}',
  '/api/v1/auth/login',
  '/api/v1/auth/me',
  '/api/v1/auth/signup',
  '/api/v1/chat/completions',
  '/api/v1/insights/me',
  '/api/v1/models',
  '/health',
];

function readContract() {
  assert.ok(
    fs.existsSync(CONTRACT_PATH),
    'contracts/openapi.json is missing. Run `npm run contract:export` and commit the result.',
  );

  return JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
}

test('the committed contract is valid OpenAPI with a title and a version', () => {
  const document = readContract();

  assert.match(document.openapi, /^3\.\d+/);
  assert.equal(typeof document.info?.title, 'string');
  assert.ok(document.info.title.length > 0);
  assert.equal(typeof document.info.version, 'string');
});

test('the contract describes every route the gateway serves', () => {
  const document = readContract();

  assert.deepEqual(Object.keys(document.paths).sort(), EXPECTED_PATHS);
});

test('the contract exposes the two bearer schemes the clients authenticate with', () => {
  const document = readContract();
  const schemes = document.components?.securitySchemes ?? {};

  assert.ok(schemes['api-key'] ?? schemes.apiKey, 'API key scheme is missing');
  assert.ok(schemes.jwt, 'JWT scheme is missing');
});

test('only the health probe sits outside the versioned base path', () => {
  const document = readContract();

  for (const route of Object.keys(document.paths)) {
    if (route === '/health') {
      continue;
    }

    assert.ok(
      route.startsWith('/api/v1/'),
      `route ${route} is not under /api/v1`,
    );
  }
});

test('the chat route documents the request fields the gateway accepts', () => {
  const document = readContract();
  const schema = document.components?.schemas?.ChatCompletionRequestDto;

  assert.ok(schema, 'ChatCompletionRequestDto is missing');
  assert.ok(schema.properties.messages, 'messages is missing');
  assert.ok(schema.properties.model, 'model is missing');
  assert.ok(schema.properties.stream, 'stream is missing');
});
