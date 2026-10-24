const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ChatRequestValidationError,
  validateChatCompletionRequest,
} = require('../dist/modules/router/schemas/chat-completion.schema.js');

const baseRequest = {
  model: 'mock',
  messages: [{ role: 'user', content: 'hello' }],
};

function expects(code, param) {
  return (error) => {
    assert.ok(error instanceof ChatRequestValidationError);
    assert.equal(error.code, code);
    if (param === undefined) {
      assert.equal(error.param, undefined);
    } else {
      assert.equal(error.param, param);
    }
    return true;
  };
}

test('accepts a supported non-streaming text request', () => {
  const request = validateChatCompletionRequest({
    ...baseRequest,
    temperature: 0.7,
    max_tokens: 100,
    stream: false,
    timeout: 5000,
  });

  assert.equal(request.model, 'mock');
  assert.equal(request.messages[0].content, 'hello');
  assert.equal(request.stream, false);
  assert.equal(request.timeout, 5000);
});

test('rejects streaming explicitly', () => {
  assert.throws(
    () => validateChatCompletionRequest({ ...baseRequest, stream: true }),
    expects('UNSUPPORTED_FEATURE', 'stream'),
  );
});

test('rejects multiple completions explicitly', () => {
  assert.throws(
    () => validateChatCompletionRequest({ ...baseRequest, n: 2 }),
    expects('UNSUPPORTED_FEATURE', 'n'),
  );
});

test('rejects tool and response-format features explicitly', () => {
  assert.throws(
    () =>
      validateChatCompletionRequest({
        ...baseRequest,
        tools: [],
      }),
    expects('UNSUPPORTED_FEATURE', 'tools'),
  );

  assert.throws(
    () =>
      validateChatCompletionRequest({
        ...baseRequest,
        response_format: { type: 'json_object' },
      }),
    expects('UNSUPPORTED_FEATURE', 'response_format'),
  );
});

test('rejects multimodal message content explicitly', () => {
  assert.throws(
    () =>
      validateChatCompletionRequest({
        model: 'mock',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
          },
        ],
      }),
    expects('UNSUPPORTED_FEATURE', 'messages.0.content'),
  );
});

test('rejects unknown request fields instead of silently dropping them', () => {
  assert.throws(
    () => validateChatCompletionRequest({ ...baseRequest, mystery: true }),
    expects('UNSUPPORTED_FEATURE', 'mystery'),
  );
});

test('rejects malformed requests with a validation error', () => {
  assert.throws(
    () => validateChatCompletionRequest({ ...baseRequest, messages: [] }),
    expects('VALIDATION_ERROR', 'messages'),
  );

  assert.throws(
    () => validateChatCompletionRequest({ ...baseRequest, temperature: 3 }),
    expects('VALIDATION_ERROR', 'temperature'),
  );

  assert.throws(
    () => validateChatCompletionRequest({ ...baseRequest, n: 1.5 }),
    expects('VALIDATION_ERROR', 'n'),
  );
});

test('rejects a non-object body with a validation error', () => {
  assert.throws(
    () => validateChatCompletionRequest('not-json'),
    expects('VALIDATION_ERROR'),
  );
});
