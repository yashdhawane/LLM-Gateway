const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseOpenAiStreamPayload,
} = require('../dist/modules/providers/openai.stream.js');
const {
  createAnthropicStreamState,
  toChatCompletionChunks,
} = require('../dist/modules/providers/anthropic.mapper.js');

// The wire formats below are copied from the provider documentation. These are
// the only transforms standing between an upstream stream and the browser, so
// every field the client reads is asserted by name.

test('passes an OpenAI chunk through unchanged', () => {
  const chunk = parseOpenAiStreamPayload(
    '{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
  );

  assert.equal(chunk.id, 'chatcmpl-1');
  assert.equal(chunk.object, 'chat.completion.chunk');
  assert.equal(chunk.choices[0].delta.content, 'Hi');
  assert.equal(chunk.choices[0].finish_reason, null);
});

test('the OpenAI done marker is not a chunk', () => {
  assert.equal(parseOpenAiStreamPayload('[DONE]'), null);
});

test('a malformed OpenAI payload is an error, not a dropped chunk', () => {
  assert.throws(() => parseOpenAiStreamPayload('{not json'), /provider/i);
  assert.throws(() => parseOpenAiStreamPayload('null'), /provider/i);
});

test('a usage-only OpenAI chunk still carries its usage', () => {
  const chunk = parseOpenAiStreamPayload(
    '{"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":7,"total_tokens":11}}',
  );

  assert.deepEqual(chunk.choices, []);
  assert.equal(chunk.usage.total_tokens, 11);
});

function anthropicBlock(event, payload) {
  return { event, data: JSON.stringify(payload) };
}

test('Anthropic message_start opens the stream with a role delta', () => {
  const state = createAnthropicStreamState('claude-3-5-haiku-latest');
  const chunks = toChatCompletionChunks(
    anthropicBlock('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        model: 'claude-3-5-haiku-20241022',
        usage: { input_tokens: 9 },
      },
    }),
    state,
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].id, 'msg_1');
  assert.equal(chunks[0].object, 'chat.completion.chunk');
  assert.equal(chunks[0].model, 'claude-3-5-haiku-20241022');
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant' });
  assert.equal(chunks[0].choices[0].finish_reason, null);
  assert.equal(state.promptTokens, 9);
});

test('Anthropic text deltas become content deltas', () => {
  const state = createAnthropicStreamState('claude');
  toChatCompletionChunks(
    anthropicBlock('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 3 } },
    }),
    state,
  );

  const chunks = toChatCompletionChunks(
    anthropicBlock('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    }),
    state,
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].id, 'msg_1');
  assert.equal(chunks[0].model, 'claude-x');
  assert.equal(chunks[0].choices[0].delta.content, 'Hello');
});

test('Anthropic message_delta closes with a mapped finish reason and usage', () => {
  const state = createAnthropicStreamState('claude');
  toChatCompletionChunks(
    anthropicBlock('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 9 } },
    }),
    state,
  );

  const chunks = toChatCompletionChunks(
    anthropicBlock('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { output_tokens: 5 },
    }),
    state,
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].choices[0].finish_reason, 'length');
  assert.deepEqual(chunks[0].usage, {
    prompt_tokens: 9,
    completion_tokens: 5,
    total_tokens: 14,
  });
});

test('Anthropic events with nothing to forward produce no chunk', () => {
  const state = createAnthropicStreamState('claude');

  for (const [event, payload] of [
    ['ping', { type: 'ping' }],
    ['content_block_start', { type: 'content_block_start', index: 0 }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_stop', { type: 'message_stop' }],
  ]) {
    assert.deepEqual(toChatCompletionChunks(anthropicBlock(event, payload), state), [], event);
  }
});

test('Anthropic end_turn closes with stop', () => {
  const state = createAnthropicStreamState('claude');

  const chunks = toChatCompletionChunks(
    anthropicBlock('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    }),
    state,
  );

  assert.equal(chunks[0].choices[0].finish_reason, 'stop');
});
