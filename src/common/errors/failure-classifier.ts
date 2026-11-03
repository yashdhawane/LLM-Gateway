import { HttpException } from '@nestjs/common';
import {
  ProviderError,
  type ProviderErrorCode,
} from '../../modules/providers/base.provider';
import {
  ERROR_DEFINITIONS,
  errorDefinitionForHttpStatus,
  isGatewayErrorCode,
  type FailureClass,
  type GatewayErrorCode,
} from './error-taxonomy';

/**
 * The only provider codes worth retrying. Mirrors the historical
 * `RETRYABLE_CODES` set so retry policy has a single owner.
 */
const RETRYABLE_PROVIDER_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
]);

export interface ClassifiedError {
  /** Internal, for logging and routing. */
  errorCode: GatewayErrorCode;
  /** What the client already receives; unknown code strings pass through unchanged. */
  wireCode: string;
  failureClass: FailureClass;
  httpStatus: number;
  message: string; // client-safe
  param?: string; // caller rejections only; reproduced verbatim
  providerStatus?: number;
  retryable: boolean;
  isProviderError: boolean;
}

export function failureClassForProviderCode(
  code: ProviderErrorCode,
): FailureClass {
  return ERROR_DEFINITIONS[code].failureClass;
}

export function isRetryableProviderCode(code: ProviderErrorCode): boolean {
  return RETRYABLE_PROVIDER_CODES.has(code);
}

export function classifyProviderError(error: ProviderError): ClassifiedError {
  const definition = ERROR_DEFINITIONS[error.code];

  return {
    errorCode: error.code,
    wireCode: definition.wireCode,
    failureClass: definition.failureClass,
    httpStatus: definition.httpStatus,
    // The provider's own message can contain upstream detail: always use the
    // fixed, client-safe definition message.
    message: definition.message,
    providerStatus: error.providerStatus,
    retryable: isRetryableProviderCode(error.code),
    isProviderError: true,
  };
}

export function classifyCallerRejection(input: {
  code: 'VALIDATION_ERROR' | 'UNSUPPORTED_FEATURE';
  message: string;
  param?: string;
}): ClassifiedError {
  const definition = ERROR_DEFINITIONS[input.code];

  return {
    errorCode: input.code,
    wireCode: definition.wireCode,
    failureClass: definition.failureClass,
    httpStatus: definition.httpStatus,
    message: input.message,
    param: input.param,
    retryable: false,
    isProviderError: false,
  };
}

function responseBodyOf(exception: HttpException): Record<string, unknown> {
  const response = exception.getResponse();

  if (typeof response === 'string') {
    return { message: response };
  }

  if (response !== null && typeof response === 'object') {
    return response as Record<string, unknown>;
  }

  return {};
}

function normalizeMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (Array.isArray(value)) {
    const messages = value.filter(
      (item): item is string => typeof item === 'string',
    );
    return messages.length ? messages.join('; ') : undefined;
  }

  return undefined;
}

/**
 * Classifies anything thrown by the request pipeline.
 *
 * Order matters: `ProviderError` -> `HttpException` (read
 * `getResponse().code`) -> `Error` -> `INTERNAL` / `Internal server error`.
 */
export function classifyException(error: unknown): ClassifiedError {
  if (error instanceof ProviderError) {
    return classifyProviderError(error);
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    const body = responseBodyOf(error);
    const wireCode = typeof body.code === 'string' ? body.code : undefined;
    const param = typeof body.param === 'string' ? body.param : undefined;
    const definition = errorDefinitionForHttpStatus(status, wireCode);

    return {
      // Recognised codes map to a GatewayErrorCode; unknown strings are only
      // preserved on the wire, with an internal fallback identifier.
      errorCode:
        wireCode !== undefined && isGatewayErrorCode(wireCode)
          ? wireCode
          : 'INTERNAL_ERROR',
      wireCode: definition.wireCode,
      failureClass: definition.failureClass,
      httpStatus: status,
      message: normalizeMessage(body.message) ?? error.message,
      param,
      retryable: false,
      isProviderError: false,
    };
  }

  // `Error` and anything else: never leak internal detail to API clients.
  return {
    errorCode: 'INTERNAL_ERROR',
    wireCode: 'INTERNAL_ERROR',
    failureClass: 'INTERNAL',
    httpStatus: 500,
    message: 'Internal server error',
    retryable: false,
    isProviderError: false,
  };
}

/**
 * Rebuilds the `HttpException` the client already receives.
 *
 * Provider errors keep the current body `{ code, message, statusCode }` with no
 * `param` key. Caller rejections keep `{ code, message, param, statusCode }`
 * with the key always present. Everything else is returned untouched, so the
 * controller can `throw` it unchanged.
 */
export function toHttpException(
  classified: ClassifiedError,
  original?: unknown,
): unknown {
  if (classified.isProviderError) {
    return new HttpException(
      {
        code: classified.wireCode,
        message: classified.message,
        statusCode: classified.httpStatus,
      },
      classified.httpStatus,
    );
  }

  if (
    classified.errorCode === 'VALIDATION_ERROR' ||
    classified.errorCode === 'UNSUPPORTED_FEATURE'
  ) {
    return new HttpException(
      {
        code: classified.wireCode,
        message: classified.message,
        param: classified.param,
        statusCode: classified.httpStatus,
      },
      classified.httpStatus,
    );
  }

  return original;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{4,}/g,
  /\blg_[A-Za-z0-9_-]{4,}/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
];

/**
 * Cc (including C0/C1) and Cf (bidi overrides, zero-width characters, BOM)
 * plus the two Unicode line separators. These are invisible log-injection and
 * terminal-spoofing vectors, so they never reach a stored message.
 *
 * `Cc` contains tab/newline/CR as well; `sanitizeErrorMessage` turns those
 * three into spaces first, so ordinary whitespace stays a word separator.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** Kept in one place so the length budget below cannot drift from it. */
const TRUNCATION_SUFFIX = '…[truncated]';

function redactSecrets(text: string): string {
  let redacted = text;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[redacted]');
  }

  return redacted;
}

function stringifyForLog(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (value !== null && typeof value === 'object') {
    try {
      const serialized = JSON.stringify(value);
      if (serialized !== undefined) {
        return serialized;
      }
    } catch {
      // Fall through to String() for values JSON cannot represent.
    }
  }

  return String(value);
}

/**
 * Makes an error message safe for persistence and logs: strips control
 * characters, collapses whitespace, redacts known secret shapes and truncates
 * to **at most** `maxLength` characters, suffix included.
 *
 * Redaction runs both BEFORE and AFTER normalisation, and both directions are
 * load-bearing:
 *  - before: normalising deletes the control character that supplied the `\b`
 *    boundary, so `abc\u0001sk-abcdef123456` would become `abcsk-abcdef123456`
 *    and never match afterwards;
 *  - after: stripping a NUL can rejoin the two halves of a secret
 *    (`sk-ab\u0000cd1234` → `sk-abcd1234`), so the final text must be scanned
 *    again or the secret survives in a new shape.
 *
 * Returns `null` for empty or whitespace-only input, and for a non-positive
 * `maxLength` (nothing could be persisted within that budget).
 */
export function sanitizeErrorMessage(
  value: unknown,
  maxLength = 500,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (maxLength <= 0) {
    return null;
  }

  let text = redactSecrets(stringifyForLog(value));

  // Keep ordinary whitespace meaningful: tab/newline/CR become a space
  // before the Cc/Cf sweep removes every other invisible character.
  text = text.replace(/[\t\n\r]/g, ' ');
  text = text.replace(CONTROL_CHARACTERS, '');
  text = text.replace(/\s+/g, ' ').trim();

  // A stripped control character can rejoin a secret: scan the final shape.
  text = redactSecrets(text);

  // Redaction can leave doubled or trailing spaces behind.
  text = text.replace(/\s+/g, ' ').trim();

  if (!text) {
    return null;
  }

  return truncateForLog(text, maxLength);
}

/**
 * Truncates so the result — suffix included — is `<= maxLength`, and never
 * splits a surrogate pair. A limit too small for the suffix falls back to a
 * hard cut rather than overshooting the documented invariant.
 */
function truncateForLog(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 0) {
    return '';
  }

  const budget = maxLength - TRUNCATION_SUFFIX.length;

  if (budget < 1) {
    return sliceWithoutSplittingSurrogate(text, maxLength);
  }

  return `${sliceWithoutSplittingSurrogate(text, budget)}${TRUNCATION_SUFFIX}`;
}

function sliceWithoutSplittingSurrogate(text: string, length: number): string {
  let end = Math.max(0, Math.min(length, text.length));

  // A high surrogate at the cut would leave a lone code unit behind.
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);

    if (code >= 0xd800 && code <= 0xdbff) {
      end -= 1;
    }
  }

  return text.slice(0, end);
}
