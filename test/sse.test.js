const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SSE_DONE_FRAME,
  toSseFrame,
  toSseErrorFrame,
} = require('../dist/common/sse/sse-frame.js');
const {
  parseSseBlock,
  readSseBlocks,
} = require('../dist/common/sse/sse-parser.js');

// SSE framing is the only thing standing between a provider chunk and the
// browser, and a stray newline or a missing blank line silently merges two
// events. These tests pin the exact bytes.

test('frames a chunk as one data line followed by a blank line', () => {
  assert.equal(toSseFrame({ id: 'x' }), 'data: {"id":"x"}\n\n');
});

test('the done marker is the literal the OpenAI SDKs look for', () => {
  assert.equal(SSE_DONE_FRAME, 'data: [DONE]\n\n');
});

test('a message containing newlines still produces a single frame', () => {
  const frame = toSseFrame({ content: 'line one\nline two' });

  assert.equal(frame.split('\n\n').length, 2);
  assert.equal(JSON.parse(frame.slice('data: '.length)).content, 'line one\nline two');
});

test('an error frame keeps the same envelope as a JSON error response', () => {
  const frame = toSseErrorFrame({
    code: 'STREAM_INTERRUPTED',
    message: 'The provider stream ended early.',
    type: 'server_error',
    traceId: 'trace-1',
    statusCode: 502,
  });

  const payload = JSON.parse(frame.slice('data: '.length));

  assert.equal(payload.error.code, 'STREAM_INTERRUPTED');
  assert.equal(payload.error.type, 'server_error');
  assert.equal(payload.error.trace_id, 'trace-1');
  assert.equal(payload.error.status_code, 502);
  assert.equal(payload.error.param, null);
  assert.equal(typeof payload.error.timestamp, 'string');
});

test('an error frame defaults to a server error', () => {
  const payload = JSON.parse(
    toSseErrorFrame({ code: 'INTERNAL_ERROR', message: 'boom' }).slice('data: '.length),
  );

  assert.equal(payload.error.type, 'server_error');
  assert.equal(payload.error.status_code, 500);
});

test('parses a data-only block', () => {
  assert.deepEqual(parseSseBlock('data: {"a":1}'), {
    event: null,
    data: '{"a":1}',
  });
});

test('parses a named event and trims one leading space from the value', () => {
  assert.deepEqual(parseSseBlock('event: message_start\ndata:  {"a":1}'), {
    event: 'message_start',
    data: ' {"a":1}',
  });
});

test('joins multiple data lines with a newline', () => {
  assert.deepEqual(parseSseBlock('data: one\ndata: two'), {
    event: null,
    data: 'one\ntwo',
  });
});

test('ignores comment lines', () => {
  assert.deepEqual(parseSseBlock(': keep-alive\ndata: {"a":1}\n: trailing'), {
    event: null,
    data: '{"a":1}',
  });
});

test('returns null for a block with no data', () => {
  assert.equal(parseSseBlock('event: ping'), null);
});

async function collect(chunks) {
  const out = [];
  for await (const block of readSseBlocks(chunks)) {
    out.push(block);
  }
  return out;
}

test('reads one block that arrives in a single chunk', async () => {
  const blocks = await collect(['data: {"a":1}\n\n']);

  assert.deepEqual(blocks, [{ event: null, data: '{"a":1}' }]);
});

test('reassembles a block split across chunks, including mid-token', async () => {
  const blocks = await collect(['data: {"a"', ':1}\n', '\nevent: x\ndata: 2\n\n']);

  assert.deepEqual(blocks, [
    { event: null, data: '{"a":1}' },
    { event: 'x', data: '2' },
  ]);
});

test('handles CRLF line endings', async () => {
  const blocks = await collect(['data: {"a":1}\r\n\r\n']);

  assert.deepEqual(blocks, [{ event: null, data: '{"a":1}' }]);
});

test('flushes a final block that has no trailing blank line', async () => {
  const blocks = await collect(['data: [DONE]']);

  assert.deepEqual(blocks, [{ event: null, data: '[DONE]' }]);
});

test('yields nothing for empty keep-alive chunks', async () => {
  const blocks = await collect(['\n\n', ': ping\n\n']);

  assert.deepEqual(blocks, []);
});
