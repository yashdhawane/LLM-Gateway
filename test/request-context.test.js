const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRequestContext,
  requestedModelFromBody,
} = require('../dist/common/context/request-context.js');

// Shaped like the values the controller reads from the request: the
// authenticated user (CurrentUser), the x-trace-id / x-request-id headers,
// and the raw parsed body.
function request(overrides = {}) {
  const headers = {
    'x-trace-id': 'trace-abc',
    'x-request-id': 'request-123',
    ...overrides.headers,
  };

  return {
    headers,
    user: {
      id: 'user-1',
      apiKeyId: overrides.apiKeyId ?? 'key-1',
    },
    body: overrides.body ?? { model: 'gpt-4o-mini' },
  };
}

test('derives the context from the authenticated user and request headers', () => {
  const { headers, user, body } = request();
  const now = new Date('2026-11-02T10:00:00.000Z');

  const context = createRequestContext({
    traceId: headers['x-trace-id'],
    requestId: headers['x-request-id'],
    user,
    requestedModel: requestedModelFromBody(body),
    now,
  });

  assert.equal(context.userId, 'user-1');
  assert.equal(context.apiKeyId, 'key-1');
  assert.equal(context.traceId, 'trace-abc');
  assert.equal(context.requestId, 'request-123');
  assert.equal(context.requestedModel, 'gpt-4o-mini');
  assert.equal(context.isStream, false);
  assert.equal(context.startedAt, now);
  assert.deepEqual(Object.keys(context).sort(), [
    'apiKeyId',
    'isStream',
    'requestId',
    'requestedModel',
    'startedAt',
    'traceId',
    'userId',
  ]);
});

test('falls back to unknown when the body has no model', () => {
  assert.equal(requestedModelFromBody({}), 'unknown');
  assert.equal(requestedModelFromBody({ model: '' }), 'unknown');
  assert.equal(requestedModelFromBody({ model: 42 }), 'unknown');
  assert.equal(requestedModelFromBody({ model: null }), 'unknown');
  assert.equal(requestedModelFromBody(null), 'unknown');
  assert.equal(requestedModelFromBody(undefined), 'unknown');
  assert.equal(requestedModelFromBody('gpt-4o-mini'), 'unknown');

  const context = createRequestContext({
    traceId: 'trace-abc',
    requestId: 'request-123',
    user: { id: 'user-1', apiKeyId: null },
    requestedModel: requestedModelFromBody({}),
    now: new Date('2026-11-02T10:00:00.000Z'),
  });

  assert.equal(context.requestedModel, 'unknown');
  assert.equal(context.apiKeyId, null);
});

test('records streaming intent without enabling streaming', () => {
  const now = new Date('2026-11-02T10:00:00.000Z');

  const streaming = createRequestContext({
    traceId: 'trace-abc',
    requestId: 'request-123',
    user: { id: 'user-1', apiKeyId: 'key-1' },
    requestedModel: 'gpt-4o-mini',
    isStream: true,
    now,
  });

  // The intent is recorded as data only: the context carries a boolean and
  // never negotiates or enables a stream by itself.
  assert.equal(streaming.isStream, true);

  const nonStreaming = createRequestContext({
    traceId: 'trace-abc',
    requestId: 'request-123',
    user: { id: 'user-1', apiKeyId: 'key-1' },
    requestedModel: 'gpt-4o-mini',
    isStream: false,
    now,
  });

  assert.equal(nonStreaming.isStream, false);

  // Streaming intent does not alter any other field.
  assert.deepEqual({ ...streaming, isStream: false }, nonStreaming);
});
