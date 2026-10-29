const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CredentialManager,
} = require('../dist/modules/providers/credential.manager.js');
const {
  ProviderError,
} = require('../dist/modules/providers/base.provider.js');

function manager(values) {
  return new CredentialManager({
    get: (key) => values[key],
  });
}

test('resolves an OpenAI key from validated environment config', () => {
  const credential = manager({ OPENAI_API_KEY: 'sk-openai' }).resolve('openai');

  assert.equal(credential.apiKey, 'sk-openai');
  assert.equal(credential.baseUrl, 'https://api.openai.com');
  assert.equal(credential.source, 'environment');
});

test('allows a model-specific base URL to override the provider default', () => {
  const credential = manager({ OPENAI_API_KEY: 'sk-openai' }).resolve(
    'openai',
    'http://localhost:11434',
  );

  assert.equal(credential.baseUrl, 'http://localhost:11434');
});

test('does not require credentials for the mock provider', () => {
  const credential = manager({}).resolve('mock');

  assert.equal(credential.apiKey, undefined);
  assert.equal(credential.source, 'none');
});

test('rejects a configured provider when its key is missing', () => {
  assert.throws(
    () => manager({}).resolve('anthropic'),
    (error) =>
      error instanceof ProviderError
      && error.code === 'PROVIDER_NOT_CONFIGURED',
  );
});

test('rejects an unknown provider', () => {
  assert.throws(
    () => manager({}).resolve('unknown-provider'),
    (error) =>
      error instanceof ProviderError
      && error.code === 'PROVIDER_NOT_CONFIGURED',
  );
});
