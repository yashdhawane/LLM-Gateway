const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpException } = require('@nestjs/common');
const {
  AllExceptionsFilter,
} = require('../dist/common/filters/all-exceptions.filter.js');
const {
  ProviderError,
} = require('../dist/modules/providers/base.provider.js');
const {
  ERROR_DEFINITIONS,
  describeErrorCode,
  isGatewayErrorCode,
  errorDefinitionForHttpStatus,
} = require('../dist/common/errors/error-taxonomy.js');
const {
  failureClassForProviderCode,
  isRetryableProviderCode,
  classifyProviderError,
  classifyCallerRejection,
  classifyException,
  sanitizeErrorMessage,
  toHttpException,
} = require('../dist/common/errors/failure-classifier.js');

// The six provider codes and their §6.4 rows. Failure class, HTTP status, code,
// type and message must match character-for-character.
const PROVIDER_CASES = [
  [
    'PROVIDER_TIMEOUT',
    'TIMEOUT',
    504,
    'Provider request timed out.',
    'server_error',
  ],
  [
    'PROVIDER_RATE_LIMIT',
    'RATE_LIMIT',
    429,
    'Provider rate limit exceeded.',
    'rate_limit_error',
  ],
  [
    'PROVIDER_BAD_REQUEST',
    'CALLER_FAULT',
    400,
    'Provider rejected the request.',
    'invalid_request_error',
  ],
  [
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_UNAVAILABLE',
    502,
    'Provider is unavailable.',
    'server_error',
  ],
  [
    'PROVIDER_NOT_CONFIGURED',
    'CONFIGURATION',
    503,
    'Provider is not configured.',
    'server_error',
  ],
  [
    'PROVIDER_ERROR',
    'PROVIDER_ERROR',
    502,
    'Provider request failed.',
    'server_error',
  ],
];

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

function envelope(exception) {
  const filter = createFilter();
  const { host, result } = createHost('trace-envelope');
  filter.catch(exception, host);
  return result.body.error;
}

test('maps every provider error code to its failure class and HTTP status', () => {
  for (const [code, failureClass, httpStatus] of PROVIDER_CASES) {
    assert.equal(failureClassForProviderCode(code), failureClass, code);

    const definition = ERROR_DEFINITIONS[code];
    assert.equal(definition.failureClass, failureClass, code);
    assert.equal(definition.httpStatus, httpStatus, code);
    assert.equal(definition.wireCode, code, code);

    assert.deepEqual(describeErrorCode(code), definition, code);
    assert.equal(isGatewayErrorCode(code), true, code);
  }

  // Exactly the four members of RETRYABLE_CODES remain retryable.
  assert.equal(isRetryableProviderCode('PROVIDER_TIMEOUT'), true);
  assert.equal(isRetryableProviderCode('PROVIDER_RATE_LIMIT'), true);
  assert.equal(isRetryableProviderCode('PROVIDER_UNAVAILABLE'), true);
  assert.equal(isRetryableProviderCode('PROVIDER_ERROR'), true);
  assert.equal(isRetryableProviderCode('PROVIDER_BAD_REQUEST'), false);
  assert.equal(isRetryableProviderCode('PROVIDER_NOT_CONFIGURED'), false);

  assert.equal(isGatewayErrorCode('EMAIL_ALREADY_EXISTS'), false);
  assert.equal(isGatewayErrorCode('not-a-code'), false);
});

test('reproduces the full error envelope for every provider code and caller rejection', () => {
  for (const [code, , httpStatus, message, type] of PROVIDER_CASES) {
    const classified = classifyProviderError(
      new ProviderError(code, 'secret upstream detail'),
    );
    const exception = toHttpException(classified);

    assert.equal(exception.getStatus(), httpStatus, code);
    assert.deepEqual(
      exception.getResponse(),
      { code, message, statusCode: httpStatus },
      code,
    );
    // Provider rows carry no `param` key at all.
    assert.equal('param' in exception.getResponse(), false, code);

    const body = envelope(exception);
    assert.deepEqual(
      {
        message: body.message,
        type: body.type,
        param: body.param,
        code: body.code,
        trace_id: body.trace_id,
        status_code: body.status_code,
      },
      {
        message,
        type,
        param: null,
        code,
        trace_id: 'trace-envelope',
        status_code: httpStatus,
      },
      code,
    );
    assert.equal(typeof body.timestamp, 'string', code);
  }

  const rejections = [
    [
      'UNSUPPORTED_FEATURE',
      'Streaming is not supported yet. Set stream to false or omit it.',
      'stream',
    ],
    [
      'VALIDATION_ERROR',
      "Invalid 'messages.0.content': Multimodal content is not supported yet.",
      'messages.0.content',
    ],
  ];

  for (const [code, message, param] of rejections) {
    const classified = classifyCallerRejection({ code, message, param });
    const exception = toHttpException(classified);

    assert.equal(exception.getStatus(), 400, code);
    assert.deepEqual(
      exception.getResponse(),
      { code, message, param, statusCode: 400 },
      code,
    );
    assert.equal('param' in exception.getResponse(), true, code);

    const body = envelope(exception);
    assert.equal(body.code, code);
    assert.equal(body.message, message);
    assert.equal(body.param, param);
    assert.equal(body.type, 'invalid_request_error');
    assert.equal(body.status_code, 400);
  }

  // The `param` key stays present (value `undefined`) when nothing was thrown.
  const withoutParam = toHttpException(
    classifyCallerRejection({
      code: 'VALIDATION_ERROR',
      message: 'Request body must be a JSON object.',
    }),
  );
  assert.deepEqual(withoutParam.getResponse(), {
    code: 'VALIDATION_ERROR',
    message: 'Request body must be a JSON object.',
    param: undefined,
    statusCode: 400,
  });
  assert.equal('param' in withoutParam.getResponse(), true);
});

test('classifies validation and unsupported features as caller faults without dropping param', () => {
  const unsupported = classifyCallerRejection({
    code: 'UNSUPPORTED_FEATURE',
    message: 'Streaming is not supported yet. Set stream to false or omit it.',
    param: 'stream',
  });

  assert.equal(unsupported.errorCode, 'UNSUPPORTED_FEATURE');
  assert.equal(unsupported.wireCode, 'UNSUPPORTED_FEATURE');
  assert.equal(unsupported.failureClass, 'CALLER_FAULT');
  assert.equal(unsupported.httpStatus, 400);
  assert.equal(unsupported.param, 'stream');
  assert.equal(unsupported.retryable, false);
  assert.equal(unsupported.isProviderError, false);

  const validation = classifyCallerRejection({
    code: 'VALIDATION_ERROR',
    message: "Invalid 'temperature': expected number.",
    param: 'temperature',
  });

  assert.equal(validation.errorCode, 'VALIDATION_ERROR');
  assert.equal(validation.wireCode, 'VALIDATION_ERROR');
  assert.equal(validation.failureClass, 'CALLER_FAULT');
  assert.equal(validation.httpStatus, 400);
  assert.equal(validation.param, 'temperature');

  // A rebuild followed by a classification keeps the param and the class.
  const rebuilt = classifyException(toHttpException(unsupported));
  assert.equal(rebuilt.failureClass, 'CALLER_FAULT');
  assert.equal(rebuilt.wireCode, 'UNSUPPORTED_FEATURE');
  assert.equal(rebuilt.message, unsupported.message);
  assert.equal(rebuilt.param, 'stream');
  assert.equal(rebuilt.httpStatus, 400);

  // Missing param stays absent rather than becoming null or an empty string.
  const noParam = classifyCallerRejection({
    code: 'VALIDATION_ERROR',
    message: 'Request body must be a JSON object.',
  });
  assert.equal(noParam.param, undefined);
});

test('classifies unexpected errors as internal without leaking messages', () => {
  const original = new Error('database password leaked');
  const internal = classifyException(original);

  assert.equal(internal.errorCode, 'INTERNAL_ERROR');
  assert.equal(internal.wireCode, 'INTERNAL_ERROR');
  assert.equal(internal.failureClass, 'INTERNAL');
  assert.equal(internal.httpStatus, 500);
  assert.equal(internal.message, 'Internal server error');
  assert.equal(internal.message.includes('password'), false);
  assert.equal(internal.retryable, false);
  assert.equal(internal.isProviderError, false);
  assert.equal(internal.param, undefined);
  assert.equal(internal.providerStatus, undefined);

  for (const value of ['boom', null, undefined, 42, { reason: 'secret' }]) {
    const classified = classifyException(value);
    assert.equal(classified.message, 'Internal server error');
    assert.equal(classified.failureClass, 'INTERNAL');
  }

  // Anything that is not a provider error or a caller rejection is rethrown
  // untouched, so the filter still logs the original stack.
  assert.equal(toHttpException(internal, original), original);
});

test('redacts secrets and truncates long error messages', () => {
  assert.equal(
    sanitizeErrorMessage('upstream rejected key sk-abcdef123456 for us'),
    'upstream rejected key [redacted] for us',
  );
  assert.equal(
    sanitizeErrorMessage('gateway key lg_1234abcd is inactive'),
    'gateway key [redacted] is inactive',
  );
  assert.equal(
    sanitizeErrorMessage('Authorization: Bearer abc.def-ghi rejected'),
    'Authorization: [redacted] rejected',
  );

  assert.equal(sanitizeErrorMessage(''), null);
  assert.equal(sanitizeErrorMessage('   '), null);
  assert.equal(sanitizeErrorMessage(null), null);
  assert.equal(sanitizeErrorMessage(undefined), null);

  // Control characters are stripped and whitespace is collapsed.
  assert.equal(sanitizeErrorMessage('a\u0000b\n\n  c'), 'ab c');

  // C1 controls, line/paragraph separators and Unicode format characters are
  // also stripped: they are invisible log-injection and terminal-spoofing
  // vectors even though they are not C0 controls.
  assert.equal(sanitizeErrorMessage('a\u0085b\u009Fc'), 'abc');
  assert.equal(sanitizeErrorMessage('a\u2028b\u2029c'), 'abc');
  assert.equal(sanitizeErrorMessage('a\u200Bb\u202Ec\uFEFFd'), 'abcd');

  // Tab, newline and carriage return stay word separators after collapsing.
  assert.equal(sanitizeErrorMessage('a\tb\r\nc'), 'a b c');

  // A stripped format character can rejoin the two halves of a secret, so the
  // post-strip redaction pass must catch the new shape.
  assert.equal(
    sanitizeErrorMessage('key sk-abc\u200Bdef123 end'),
    'key [redacted] end',
  );

  const long = 'x'.repeat(600);
  const truncated = sanitizeErrorMessage(long);
  // Invariant: the total, suffix included, never exceeds maxLength.
  assert.equal(truncated.startsWith('x'.repeat(488)), true);
  assert.equal(truncated.length <= 500, true);
  assert.equal(truncated.endsWith('…[truncated]'), true);

  const shortLimit = sanitizeErrorMessage('abcdefghijklmnop', 10);
  assert.equal(shortLimit.startsWith('abcdefghij'), true);
  assert.equal(shortLimit.length <= 10, true);
});

test('keeps provider wire codes unchanged', () => {
  for (const [code] of PROVIDER_CASES) {
    const classified = classifyProviderError(
      new ProviderError(code, 'secret upstream detail'),
    );

    assert.equal(classified.wireCode, code);
    assert.equal(classified.errorCode, code);
    // Persisted codes take wireCode, so the log matches the client.
    assert.equal(classified.errorCode, classified.wireCode);
    assert.equal(classified.isProviderError, true);
  }

  // Codes outside the taxonomy keep their wire string; only the internal
  // identifier falls back.
  const conflict = new HttpException(
    {
      code: 'EMAIL_ALREADY_EXISTS',
      message: 'An account with this email already exists',
      statusCode: 409,
    },
    409,
  );
  const classified = classifyException(conflict);
  assert.equal(classified.wireCode, 'EMAIL_ALREADY_EXISTS');
  assert.equal(classified.failureClass, 'CALLER_FAULT');
  assert.equal(classified.httpStatus, 409);
  assert.equal(classified.message, 'An account with this email already exists');

  // errorDefinitionForHttpStatus reproduces the filter defaults.
  assert.equal(errorDefinitionForHttpStatus(404).wireCode, 'NOT_FOUND');
  assert.equal(errorDefinitionForHttpStatus(429).wireCode, 'RATE_LIMIT_ERROR');
  assert.equal(errorDefinitionForHttpStatus(500).wireCode, 'INTERNAL_ERROR');
  assert.equal(errorDefinitionForHttpStatus(400).wireCode, 'VALIDATION_ERROR');
  assert.equal(
    errorDefinitionForHttpStatus(502, 'PROVIDER_UNAVAILABLE').wireCode,
    'PROVIDER_UNAVAILABLE',
  );
});
