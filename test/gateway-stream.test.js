const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRequestContext,
} = require('../dist/common/context/request-context.js');
const {
  ResilienceService,
} = require('../dist/modules/providers/resilience.service.js');
const {
  ProviderError,
} = require('../dist/modules/providers/base.provider.js');
const { GatewayService } = require('../dist/modules/gateway/gateway.service.js');

// Streaming has one property the blocking path does not: the HTTP status is
// committed as soon as the first chunk leaves, so retry and fallback are only
// allowed before that byte. These tests pin that boundary, the chunk shape the
// client reads, and the row that records what actually happened.

const user = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'DEVELOPER',
  apiKeyId: 'key-1',
  ownerId: 'user-1',
  ownerType: 'USER',
};

function target(overrides = {}) {
  return {
    modelId: 'model-1',
    modelName: 'public-model',
    upstreamModel: 'upstream-model',
    provider: 'mock',
    timeoutMs: 1000,
    maxRetries: 0,
    cooldownMs: 0,
    ...overrides,
  };
}

function requestContext(isStream = true) {
  return createRequestContext({
    user,
    traceId: 'trace-1',
    requestId: 'request-1',
    requestedModel: 'public-model',
    isStream,
  });
}

function roleChunk() {
  return {
    id: 'completion-1',
    object: 'chat.completion.chunk',
    created: 10,
    model: 'upstream-model',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
}

function textChunk(text) {
  return {
    id: 'completion-1',
    object: 'chat.completion.chunk',
    created: 10,
    model: 'upstream-model',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function finishChunk(usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }) {
  return {
    id: 'completion-1',
    object: 'chat.completion.chunk',
    created: 10,
    model: 'upstream-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage,
  };
}

function usageOnlyChunk() {
  return {
    id: 'completion-1',
    object: 'chat.completion.chunk',
    created: 10,
    model: 'upstream-model',
    choices: [],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

function createSink() {
  const controller = new AbortController();
  const frames = [];
  const errors = [];
  const ops = [];
  let open = false;

  const sink = {
    frames,
    errors,
    ops,
    ended: false,
    onWrite: null,
    get isOpen() {
      return open;
    },
    get aborted() {
      return controller.signal.aborted;
    },
    signal: controller.signal,
    open() {
      ops.push('open');
      open = true;
    },
    async write(payload) {
      ops.push('write');
      frames.push(payload);
      if (sink.onWrite) {
        await sink.onWrite(sink, payload);
      }
    },
    end() {
      ops.push('end');
      sink.ended = true;
    },
    fail(payload) {
      ops.push('fail');
      errors.push(payload);
      sink.ended = true;
    },
    abort() {
      controller.abort();
    },
  };

  return sink;
}

function createHarness({ targets, streamFor, requestLogs } = {}) {
  const started = [];
  const attempts = [];
  const finalized = [];
  const failures = [];
  const telemetryEvents = [];
  const telemetryErrors = [];
  const calls = [];

  const logs = requestLogs ?? {
    start: async (input) => {
      started.push(input);
      return { id: 'log-1' };
    },
    appendAttempt: async (input) => {
      attempts.push(input);
    },
    finalizeSuccess: async (input) => {
      finalized.push(input);
      return true;
    },
    finalizeFailure: async (input) => {
      failures.push(input);
      return true;
    },
  };

  const service = new GatewayService(
    {
      resolveRoute: async () => ({
        requestedModel: 'public-model',
        targets: targets ?? [target()],
      }),
    },
    {
      streamChatCompletion: (name, request, options, traceId) => {
        calls.push({ name, request, options, traceId });
        return streamFor(name, request, options, traceId, calls.length - 1);
      },
      chatCompletion: async () => {
        throw new Error('the blocking path must not run for a stream');
      },
    },
    logs,
    {
      logRequest: (event) => telemetryEvents.push(event),
      logError: (event) => telemetryErrors.push(event),
    },
    { resolve: () => ({ apiKey: undefined, baseUrl: undefined, source: 'none' }) },
    new ResilienceService(),
    { calculate: async () => null },
  );

  return {
    service,
    started,
    attempts,
    finalized,
    failures,
    telemetryEvents,
    telemetryErrors,
    calls,
  };
}

function streamOf(chunks) {
  return async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  };
}

test('streams chunks in order, commits on the first one, and finalizes usage', async () => {
  const sink = createSink();
  const harness = createHarness({
    streamFor: streamOf([roleChunk(), textChunk('Hi'), finishChunk(), usageOnlyChunk()]),
  });

  const request = {
    model: 'public-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  };

  await harness.service.streamCompletion(request, requestContext(), sink);

  // The response is open before the first chunk is written, never before.
  assert.deepEqual(sink.ops.slice(0, 2), ['open', 'write']);
  assert.equal(sink.isOpen, true);
  assert.equal(sink.ended, true);
  assert.equal(sink.errors.length, 0);

  // The usage-only chunk is stripped, not forwarded as an empty event.
  assert.equal(sink.frames.length, 3);
  assert.deepEqual(sink.frames[0].choices[0].delta, { role: 'assistant' });
  assert.equal(sink.frames[1].choices[0].delta.content, 'Hi');
  assert.equal(sink.frames[2].choices[0].finish_reason, 'stop');
  assert.equal(sink.frames[2].usage, undefined);
  for (const frame of sink.frames) {
    assert.equal(frame.trace_id, 'trace-1');
  }

  assert.equal(harness.started.length, 1);
  assert.equal(harness.started[0].isStream, true);

  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].status, 'SUCCEEDED');
  assert.equal(harness.attempts[0].isStream, true);
  assert.equal(harness.attempts[0].provider, 'mock');
  assert.equal(harness.attempts[0].servedModel, 'upstream-model');
  assert.equal(typeof harness.attempts[0].timeToFirstTokenMs, 'number');

  assert.equal(harness.finalized.length, 1);
  assert.equal(harness.finalized[0].statusCode, 200);
  assert.equal(harness.finalized[0].provider, 'mock');
  assert.equal(harness.finalized[0].servedModel, 'upstream-model');
  assert.equal(harness.finalized[0].totalTokens, 5);
  assert.equal(harness.finalized[0].attemptCount, 1);

  assert.equal(harness.telemetryEvents.length, 1);
  assert.equal(harness.telemetryEvents[0].statusCode, 200);
  assert.equal(harness.telemetryEvents[0].totalTokens, 5);
  assert.equal(harness.telemetryErrors.length, 0);
});

test('emits one usage-only chunk at the end when the client opts in', async () => {
  const sink = createSink();
  const harness = createHarness({
    streamFor: streamOf([roleChunk(), finishChunk(), usageOnlyChunk()]),
  });

  await harness.service.streamCompletion(
    {
      model: 'public-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      stream_options: { include_usage: true },
    },
    requestContext(),
    sink,
  );

  assert.equal(sink.frames.length, 3);
  const last = sink.frames[sink.frames.length - 1];
  assert.deepEqual(last.choices, []);
  assert.deepEqual(last.usage, {
    prompt_tokens: 2,
    completion_tokens: 3,
    total_tokens: 5,
  });
  // Usage never rides on a content chunk...
  assert.equal(sink.frames[0].usage, undefined);
  assert.equal(sink.frames[1].usage, undefined);
});

test('a provider failure after the first chunk becomes an error frame, not a retry', async () => {
  const sink = createSink();
  const harness = createHarness({
    targets: [target({ modelId: 'model-1' }), target({ modelId: 'model-2' })],
    streamFor: async function* () {
      yield roleChunk();
      throw new ProviderError('PROVIDER_ERROR', 'upstream exploded');
    },
  });

  await harness.service.streamCompletion(
    { model: 'public-model', messages: [{ role: 'user', content: 'hello' }], stream: true },
    requestContext(),
    sink,
  );

  // No fallback: the client already has bytes and a second provider would
  // restart the answer mid-sentence.
  assert.equal(harness.calls.length, 1);

  assert.equal(sink.frames.length, 1);
  assert.equal(sink.errors.length, 1);
  assert.equal(sink.errors[0].code, 'PROVIDER_ERROR');
  assert.equal(sink.errors[0].statusCode, 502);
  assert.equal(sink.errors[0].traceId, 'trace-1');
  assert.equal(sink.ended, true);

  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].status, 'FAILED');
  assert.equal(harness.attempts[0].isStream, true);
  assert.equal(harness.finalized.length, 0);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].statusCode, 502);
  assert.equal(harness.failures[0].errorCode, 'PROVIDER_ERROR');
});

test('falls back to the next target when the failure happens before any byte', async () => {
  const sink = createSink();
  const harness = createHarness({
    targets: [
      target({ modelId: 'model-1', provider: 'openai' }),
      target({ modelId: 'model-2', provider: 'mock' }),
    ],
    streamFor: (name, request, options, traceId, index) => {
      if (index === 0) {
        return (async function* () {
          throw new ProviderError('PROVIDER_UNAVAILABLE', 'first provider down');
        })();
      }

      return streamOf([roleChunk(), finishChunk()])();
    },
  });

  await harness.service.streamCompletion(
    { model: 'public-model', messages: [{ role: 'user', content: 'hello' }], stream: true },
    requestContext(),
    sink,
  );

  assert.equal(harness.calls.length, 2);
  assert.equal(sink.errors.length, 0);
  assert.equal(sink.ended, true);
  assert.equal(sink.frames.length, 2);

  assert.equal(harness.attempts.length, 2);
  assert.equal(harness.attempts[0].status, 'FAILED');
  assert.equal(harness.attempts[0].isFallback, false);
  assert.equal(harness.attempts[1].status, 'SUCCEEDED');
  assert.equal(harness.attempts[1].isFallback, true);
  assert.equal(harness.finalized[0].fallbackUsed, true);
  assert.equal(harness.finalized[0].attemptCount, 2);
});

test('rethrows when every target fails before the response is committed', async () => {
  const sink = createSink();
  const harness = createHarness({
    targets: [target({ modelId: 'model-1' }), target({ modelId: 'model-2' })],
    streamFor: () =>
      (async function* () {
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'down');
      })(),
  });

  await assert.rejects(
    harness.service.streamCompletion(
      { model: 'public-model', messages: [{ role: 'user', content: 'hello' }], stream: true },
      requestContext(),
      sink,
    ),
    (error) => error instanceof ProviderError && error.code === 'PROVIDER_UNAVAILABLE',
  );

  // Nothing was committed, so the controller can still answer with JSON.
  assert.equal(sink.isOpen, false);
  assert.deepEqual(sink.errors, []);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].statusCode, 502);
  assert.equal(harness.failures[0].attemptCount, 2);
});

test('a client disconnect stops the provider and records an abandoned request', async () => {
  const sink = createSink();
  const harness = createHarness({
    streamFor: streamOf([roleChunk(), textChunk('a'), textChunk('b'), finishChunk()]),
  });

  sink.onWrite = async (self) => {
    self.onWrite = null;
    self.abort();
  };

  await harness.service.streamCompletion(
    { model: 'public-model', messages: [{ role: 'user', content: 'hello' }], stream: true },
    requestContext(),
    sink,
  );

  // The second chunk is never written and no error frame is attempted: the
  // socket is already gone.
  assert.equal(sink.frames.length, 1);
  assert.deepEqual(sink.errors, []);
  assert.equal(harness.finalized.length, 0);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].errorCode, 'CLIENT_DISCONNECTED');
  assert.equal(harness.failures[0].failureClass, 'ABANDONED');
  assert.equal(harness.failures[0].statusCode, 499);
  assert.equal(harness.telemetryErrors.length, 1);
});

test('a stream that ends without a finish chunk is reported as interrupted', async () => {
  const sink = createSink();
  const harness = createHarness({
    streamFor: streamOf([roleChunk(), textChunk('par')]),
  });

  await harness.service.streamCompletion(
    { model: 'public-model', messages: [{ role: 'user', content: 'hello' }], stream: true },
    requestContext(),
    sink,
  );

  assert.equal(sink.frames.length, 2);
  assert.equal(sink.errors.length, 1);
  assert.equal(sink.errors[0].code, 'STREAM_INTERRUPTED');
  assert.equal(sink.errors[0].statusCode, 502);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].errorCode, 'STREAM_INTERRUPTED');
  assert.equal(harness.failures[0].statusCode, 502);
});

test('an empty stream is a provider failure and never opens the response', async () => {
  const sink = createSink();
  const harness = createHarness({ streamFor: streamOf([]) });

  await assert.rejects(
    harness.service.streamCompletion(
      { model: 'public-model', messages: [{ role: 'user', content: 'hello' }], stream: true },
      requestContext(),
      sink,
    ),
    (error) => error instanceof ProviderError && error.code === 'PROVIDER_ERROR',
  );

  assert.equal(sink.isOpen, false);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].errorCode, 'PROVIDER_ERROR');
});

test('passes the credential, timeout and abort signal to the provider', async () => {
  const sink = createSink();
  const harness = createHarness({ streamFor: streamOf([roleChunk(), finishChunk()]) });

  await harness.service.streamCompletion(
    {
      model: 'public-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      timeout: 5000,
    },
    requestContext(),
    sink,
  );

  const call = harness.calls[0];
  assert.equal(call.name, 'mock');
  assert.equal(call.request.model, 'upstream-model');
  assert.equal(call.request.timeout, undefined);
  assert.equal(call.options.timeoutMs, 1000);
  assert.equal(call.options.baseUrl, undefined);
  assert.ok(call.options.signal instanceof AbortSignal);
  assert.equal(call.traceId, 'trace-1');
});
