const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BadRequestException,
  UnauthorizedException,
} = require('@nestjs/common');
const {
  AllExceptionsFilter,
} = require('../dist/common/filters/all-exceptions.filter.js');
const {
  GatewayController,
} = require('../dist/modules/gateway/gateway.controller.js');
const {
  ProviderError,
} = require('../dist/modules/providers/base.provider.js');

function createFilter() {
  const filter = new AllExceptionsFilter();
  filter.logger.error = () => {};
  return filter;
}

function createHost(traceId = 'trace-test') {
  const result = {
    statusCode: undefined,
    body: undefined,
  };
  const reply = {
    status(code) {
      result.statusCode = code;
      return reply;
    },
    send(body) {
      result.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({ traceId }),
    }),
  };

  return { host, result };
}

test('formats unsupported features using the stable error envelope', () => {
  const filter = createFilter();
  const { host, result } = createHost('trace-123');
  const exception = new BadRequestException({
    code: 'UNSUPPORTED_FEATURE',
    message: 'Streaming is not supported yet.',
    param: 'stream',
    statusCode: 400,
  });

  filter.catch(exception, host);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error.code, 'UNSUPPORTED_FEATURE');
  assert.equal(result.body.error.type, 'invalid_request_error');
  assert.equal(result.body.error.param, 'stream');
  assert.equal(result.body.error.trace_id, 'trace-123');
  assert.equal(result.body.error.status_code, 400);
  assert.ok(result.body.error.timestamp);
});

test('formats authentication failures consistently', () => {
  const filter = createFilter();
  const { host, result } = createHost('trace-456');
  const exception = new UnauthorizedException({
    code: 'AUTHENTICATION_ERROR',
    message: 'API key required',
    statusCode: 401,
  });

  filter.catch(exception, host);

  assert.equal(result.statusCode, 401);
  assert.equal(result.body.error.type, 'authentication_error');
  assert.equal(result.body.error.code, 'AUTHENTICATION_ERROR');
  assert.equal(result.body.error.trace_id, 'trace-456');
});

test('normalizes validation message arrays', () => {
  const filter = createFilter();
  const { host, result } = createHost('trace-789');
  const exception = new BadRequestException({
    message: ['email must be an email', 'password too short'],
    error: 'Bad Request',
    statusCode: 400,
  });

  filter.catch(exception, host);

  assert.equal(result.body.error.code, 'VALIDATION_ERROR');
  assert.equal(
    result.body.error.message,
    'email must be an email; password too short',
  );
});

test('does not expose internal error messages', () => {
  const filter = createFilter();
  const { host, result } = createHost('trace-500');

  filter.catch(new Error('database password leaked'), host);

  assert.equal(result.statusCode, 500);
  assert.equal(result.body.error.message, 'Internal server error');
  assert.equal(result.body.error.type, 'server_error');
  assert.equal(result.body.error.trace_id, 'trace-500');
});

test('maps provider failures to stable gateway status codes', () => {
  const controller = new GatewayController(null, null, null, null, null);
  const cases = [
    ['PROVIDER_TIMEOUT', 504, 'PROVIDER_TIMEOUT'],
    ['PROVIDER_RATE_LIMIT', 429, 'PROVIDER_RATE_LIMIT'],
    ['PROVIDER_BAD_REQUEST', 400, 'PROVIDER_BAD_REQUEST'],
    ['PROVIDER_UNAVAILABLE', 502, 'PROVIDER_UNAVAILABLE'],
    ['PROVIDER_ERROR', 502, 'PROVIDER_ERROR'],
  ];

  for (const [providerCode, expectedStatus, expectedCode] of cases) {
    const exception = controller.mapProviderError(
      new ProviderError(providerCode, 'provider failed'),
    );

    assert.equal(exception.getStatus(), expectedStatus);
    assert.equal(exception.getResponse().code, expectedCode);
  }
});
