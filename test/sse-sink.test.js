const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFastifyStreamSink,
} = require('../dist/common/sse/fastify-stream-sink.js');

// The sink is the last piece of code between a provider chunk and the socket.
// It has to commit the SSE headers once, keep CORS headers that Fastify already
// set, frame every payload, and notice a client that went away - without ever
// throwing back into the gateway.

function fakeReply(presetHeaders = {}) {
  const state = {
    hijacked: false,
    status: undefined,
    headers: undefined,
    chunks: [],
    ended: false,
    endedAt: undefined,
    listeners: {},
  };

  const raw = {
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    write(chunk) {
      state.chunks.push(chunk);
      return true;
    },
    end() {
      state.ended = true;
      state.endedAt = state.chunks.length;
    },
    on(event, handler) {
      state.listeners[event] = handler;
    },
    writableEnded: false,
  };

  return {
    state,
    reply: {
      hijack() {
        state.hijacked = true;
      },
      getHeaders() {
        return presetHeaders;
      },
      raw,
    },
  };
}

test('open commits 200 and the SSE headers without losing CORS headers', () => {
  const { state, reply } = fakeReply({
    'access-control-allow-origin': 'http://localhost:3000',
    'access-control-allow-credentials': 'true',
  });
  const sink = createFastifyStreamSink(reply, 'trace-1');

  sink.open();

  assert.equal(sink.isOpen, true);
  assert.equal(state.hijacked, true);
  assert.equal(state.status, 200);
  assert.equal(state.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(state.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(state.headers.connection, 'keep-alive');
  assert.equal(state.headers['x-accel-buffering'], 'no');
  assert.equal(state.headers['x-trace-id'], 'trace-1');
  assert.equal(
    state.headers['access-control-allow-origin'],
    'http://localhost:3000',
  );
});

test('every payload becomes one data frame', async () => {
  const { state, reply } = fakeReply();
  const sink = createFastifyStreamSink(reply, 'trace-1');

  sink.open();
  await sink.write({ id: 'chunk-1' });

  assert.deepEqual(state.chunks, ['data: {"id":"chunk-1"}\n\n']);
});

test('end writes the done marker and closes the response', async () => {
  const { state, reply } = fakeReply();
  const sink = createFastifyStreamSink(reply, 'trace-1');

  sink.open();
  await sink.write({ id: 'chunk-1' });
  sink.end();

  assert.deepEqual(state.chunks, [
    'data: {"id":"chunk-1"}\n\n',
    'data: [DONE]\n\n',
  ]);
  assert.equal(state.ended, true);
});

test('a second end is ignored rather than appending another marker', () => {
  const { state, reply } = fakeReply();
  const sink = createFastifyStreamSink(reply, 'trace-1');

  sink.open();
  sink.end();
  sink.end();

  assert.equal(
    state.chunks.filter((chunk) => chunk === 'data: [DONE]\n\n').length,
    1,
  );
});

test('fail writes the error envelope instead of the done marker', () => {
  const { state, reply } = fakeReply();
  const sink = createFastifyStreamSink(reply, 'trace-1');

  sink.open();
  sink.fail({
    code: 'STREAM_INTERRUPTED',
    message: 'The provider stream ended early.',
    statusCode: 502,
  });

  const payload = JSON.parse(state.chunks[0].slice('data: '.length));
  assert.equal(payload.error.code, 'STREAM_INTERRUPTED');
  assert.equal(payload.error.trace_id, 'trace-1');
  assert.equal(state.chunks.includes('data: [DONE]\n\n'), false);
  assert.equal(state.ended, true);
});

test('the sink never writes before open', async () => {
  const { state, reply } = fakeReply();
  const sink = createFastifyStreamSink(reply, 'trace-1');

  await sink.write({ id: 'chunk-1' });
  sink.end();

  assert.deepEqual(state.chunks, []);
  assert.equal(state.ended, false);
});

test('a client close aborts the signal and silences later writes', async () => {
  const { state, reply } = fakeReply();
  const sink = createFastifyStreamSink(reply, 'trace-1');

  sink.open();
  assert.equal(sink.aborted, false);

  state.listeners.close();
  assert.equal(sink.aborted, true);

  await sink.write({ id: 'late' });
  sink.fail({ code: 'STREAM_INTERRUPTED', message: 'late' });

  assert.deepEqual(state.chunks, []);
  assert.equal(state.ended, false);
});

test('a normal end is not mistaken for a client disconnect', () => {
  const { state, reply } = fakeReply();
  const sink = createFastifyStreamSink(reply, 'trace-1');

  sink.open();
  sink.end();

  // Node emits `close` on the response after a normal end as well.
  state.listeners.close();
  assert.equal(sink.aborted, false);
});
