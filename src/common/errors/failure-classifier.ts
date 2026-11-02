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
 * Makes an error message safe for persistence and logs: redacts known secret
 * shapes, strips control characters, collapses whitespace and truncates.
 * Returns `null` for empty or whitespace-only input.
 */
export function sanitizeErrorMessage(
  value: unknown,
  maxLength = 500,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  let text = stringifyForLog(value);

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted]');
  }

  // Strip control characters (keeping ordinary whitespace), then collapse.
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  text = text.replace(/\s+/g, ' ').trim();

  if (!text) {
    return null;
  }

  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}…[truncated]`;
  }

  return text;
}
