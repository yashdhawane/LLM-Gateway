const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toAnthropicRequest,
  toChatCompletionResponse,
} = require('../dist/modules/providers/anthropic.mapper.js');

test('normalizes an OpenAI-style request for Anthropic', () => {
  const request = toAnthropicRequest({
    model: 'claude-3-5-haiku-latest',
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ],
    max_tokens: 64,
    temperature: 0.2,
    stop: 'END',
    user: 'end-user-1',
  });

  assert.equal(request.model, 'claude-3-5-haiku-latest');
  assert.equal(request.max_tokens, 64);
  assert.equal(request.system, 'Be concise.');
  assert.deepEqual(request.messages, [{ role: 'user', content: 'Hello' }]);
  assert.equal(request.temperature, 0.2);
  assert.deepEqual(request.stop_sequences, ['END']);
  assert.deepEqual(request.metadata, { user_id: 'end-user-1' });
});

test('uses a safe default max_tokens for Anthropic', () => {
  const request = toAnthropicRequest({
    model: 'claude-3-5-haiku-latest',
    messages: [{ role: 'user', content: 'Hello' }],
  });

  assert.equal(request.max_tokens, 1024);
});

test('rejects Anthropic-unsupported sampling parameters instead of dropping them', () => {
  assert.throws(
    () =>
      toAnthropicRequest({
        model: 'claude-3-5-haiku-latest',
        messages: [{ role: 'user', content: 'Hello' }],
        presence_penalty: 0.1,
      }),
    (error) =>
      error.name === 'ProviderError'
      && error.code === 'PROVIDER_BAD_REQUEST'
      && /presence_penalty/.test(error.message),
  );
});

test('rejects a message name parameter instead of dropping it', () => {
  assert.throws(
    () =>
      toAnthropicRequest({
        model: 'claude-3-5-haiku-latest',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello', name: 'alice' },
        ],
      }),
    (error) =>
      error.name === 'ProviderError'
      && error.code === 'PROVIDER_BAD_REQUEST'
      && /Anthropic does not support: /i.test(error.message)
      && /messages\[1\]\.name/.test(error.message),
  );
});

test('normalizes an Anthropic response to the OpenAI-style contract', () => {
  const response = toChatCompletionResponse(
    {
      id: 'msg_123',
      model: 'claude-3-5-haiku-latest',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'there' },
      ],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 5, output_tokens: 7 },
    },
    'claude-3-5-haiku-latest',
    'trace-1',
  );

  assert.equal(response.id, 'msg_123');
  assert.equal(response.object, 'chat.completion');
  assert.equal(response.choices[0].message.content, 'Hello there');
  assert.equal(response.choices[0].finish_reason, 'length');
  assert.deepEqual(response.usage, {
    prompt_tokens: 5,
    completion_tokens: 7,
    total_tokens: 12,
  });
  assert.equal(response.trace_id, 'trace-1');
});
