import type { ProviderErrorCode } from '../../modules/providers/base.provider';

/**
 * Coarse failure taxonomy used by logging, routing and retry policy.
 * Framework-free: HTTP statuses are plain numbers so this module never
 * imports `@nestjs/common`.
 */
export type FailureClass =
  | 'CALLER_FAULT'
  | 'AUTH_FAULT'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'CONFIGURATION'
  | 'INTERNAL'
  | 'ABANDONED';

/**
 * Every code the gateway itself can classify. Provider codes are included
 * verbatim so their wire representation never changes.
 */
export type GatewayErrorCode =
  | ProviderErrorCode
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_FEATURE'
  | 'MODEL_NOT_FOUND'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'API_KEY_INVALID'
  | 'API_KEY_INACTIVE'
  | 'RATE_LIMIT_ERROR'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface ErrorDefinition {
  readonly failureClass: FailureClass;
  readonly httpStatus: number; // numeric: keeps this module free of @nestjs/common
  readonly wireCode: string; // exact code the client already receives
  readonly message: string; // exact message the client already receives
}

/**
 * Single source of truth for the §6.4 failure-classification table.
 *
 * Provider rows and `INTERNAL_ERROR` reproduce the client-visible strings
 * character-for-character. Rows whose §6.4 message is "original" (caller
 * rejections, auth, not-found, rate limit) keep a default fallback here; the
 * classifier always prefers the original exception message when there is one.
 */
export const ERROR_DEFINITIONS: Readonly<
  Record<GatewayErrorCode, ErrorDefinition>
> = Object.freeze({
  PROVIDER_TIMEOUT: {
    failureClass: 'TIMEOUT',
    httpStatus: 504,
    wireCode: 'PROVIDER_TIMEOUT',
    message: 'Provider request timed out.',
  },
  PROVIDER_RATE_LIMIT: {
    failureClass: 'RATE_LIMIT',
    httpStatus: 429,
    wireCode: 'PROVIDER_RATE_LIMIT',
    message: 'Provider rate limit exceeded.',
  },
  PROVIDER_BAD_REQUEST: {
    failureClass: 'CALLER_FAULT',
    httpStatus: 400,
    wireCode: 'PROVIDER_BAD_REQUEST',
    message: 'Provider rejected the request.',
  },
  PROVIDER_UNAVAILABLE: {
    failureClass: 'PROVIDER_UNAVAILABLE',
    httpStatus: 502,
    wireCode: 'PROVIDER_UNAVAILABLE',
    message: 'Provider is unavailable.',
  },
  PROVIDER_NOT_CONFIGURED: {
    failureClass: 'CONFIGURATION',
    httpStatus: 503,
    wireCode: 'PROVIDER_NOT_CONFIGURED',
    message: 'Provider is not configured.',
  },
  PROVIDER_ERROR: {
    failureClass: 'PROVIDER_ERROR',
    httpStatus: 502,
    wireCode: 'PROVIDER_ERROR',
    message: 'Provider request failed.',
  },
  VALIDATION_ERROR: {
    failureClass: 'CALLER_FAULT',
    httpStatus: 400,
    wireCode: 'VALIDATION_ERROR',
    message: 'Invalid request.',
  },
  UNSUPPORTED_FEATURE: {
    failureClass: 'CALLER_FAULT',
    httpStatus: 400,
    wireCode: 'UNSUPPORTED_FEATURE',
    message: 'This feature is not supported.',
  },
  MODEL_NOT_FOUND: {
    failureClass: 'CALLER_FAULT',
    httpStatus: 404,
    wireCode: 'MODEL_NOT_FOUND',
    message: 'Model not found or inactive',
  },
  AUTHENTICATION_ERROR: {
    failureClass: 'AUTH_FAULT',
    httpStatus: 401,
    wireCode: 'AUTHENTICATION_ERROR',
    message: 'Authentication required',
  },
  AUTHORIZATION_ERROR: {
    failureClass: 'AUTH_FAULT',
    httpStatus: 403,
    wireCode: 'AUTHORIZATION_ERROR',
    message: 'Insufficient permissions',
  },
  API_KEY_INVALID: {
    failureClass: 'AUTH_FAULT',
    httpStatus: 401,
    wireCode: 'API_KEY_INVALID',
    message: 'Invalid API key',
  },
  API_KEY_INACTIVE: {
    failureClass: 'AUTH_FAULT',
    httpStatus: 401,
    wireCode: 'API_KEY_INACTIVE',
    message: 'API key is inactive',
  },
  RATE_LIMIT_ERROR: {
    failureClass: 'RATE_LIMIT',
    httpStatus: 429,
    wireCode: 'RATE_LIMIT_ERROR',
    message: 'Too many requests',
  },
  NOT_FOUND: {
    failureClass: 'CALLER_FAULT',
    httpStatus: 404,
    wireCode: 'NOT_FOUND',
    message: 'Not found',
  },
  INTERNAL_ERROR: {
    failureClass: 'INTERNAL',
    httpStatus: 500,
    wireCode: 'INTERNAL_ERROR',
    message: 'Internal server error',
  },
});

/** Fallback messages for filter-default wire codes outside the taxonomy. */
const EXTRA_WIRE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  EMAIL_ALREADY_EXISTS: 'An account with this email already exists',
});

export function describeErrorCode(code: GatewayErrorCode): ErrorDefinition {
  return ERROR_DEFINITIONS[code];
}

export function isGatewayErrorCode(value: string): value is GatewayErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_DEFINITIONS, value);
}

/** Mirrors `AllExceptionsFilter`'s `defaultCodeForStatus`. */
function defaultWireCodeForStatus(status: number): string {
  if (status === 401) return 'AUTHENTICATION_ERROR';
  if (status === 403) return 'AUTHORIZATION_ERROR';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'EMAIL_ALREADY_EXISTS';
  if (status === 429) return 'RATE_LIMIT_ERROR';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'VALIDATION_ERROR';
}

function failureClassForStatus(status: number): FailureClass {
  if (status === 401 || status === 403) return 'AUTH_FAULT';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'INTERNAL';
  return 'CALLER_FAULT';
}

function defaultMessageForStatus(status: number, wireCode: string): string {
  if (isGatewayErrorCode(wireCode)) {
    return ERROR_DEFINITIONS[wireCode].message;
  }

  return EXTRA_WIRE_MESSAGES[wireCode] ?? 'Request failed';
}

/**
 * Resolves a definition for an HTTP status, keeping a recognised `wireCode`
 * when one is supplied and otherwise reproducing the filter's defaults.
 */
export function errorDefinitionForHttpStatus(
  status: number,
  wireCode?: string,
): ErrorDefinition {
  if (wireCode !== undefined && isGatewayErrorCode(wireCode)) {
    const definition = ERROR_DEFINITIONS[wireCode];
    return definition.httpStatus === status
      ? definition
      : { ...definition, httpStatus: status };
  }

  const resolvedWireCode = wireCode ?? defaultWireCodeForStatus(status);
  return {
    failureClass: failureClassForStatus(status),
    httpStatus: status,
    wireCode: resolvedWireCode,
    message: defaultMessageForStatus(status, resolvedWireCode),
  };
}
