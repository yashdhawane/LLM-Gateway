import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';

export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNSUPPORTED_FEATURE = 'UNSUPPORTED_FEATURE',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR = 'AUTHORIZATION_ERROR',
  EMAIL_ALREADY_EXISTS = 'EMAIL_ALREADY_EXISTS',
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  PROVIDER_TIMEOUT = 'PROVIDER_TIMEOUT',
  PROVIDER_RATE_LIMIT = 'PROVIDER_RATE_LIMIT',
  PROVIDER_BAD_REQUEST = 'PROVIDER_BAD_REQUEST',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  PROVIDER_NOT_CONFIGURED = 'PROVIDER_NOT_CONFIGURED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
  API_KEY_INVALID = 'API_KEY_INVALID',
  API_KEY_INACTIVE = 'API_KEY_INACTIVE',
}

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'rate_limit_error'
  | 'server_error';

export interface ErrorResponse {
  error: {
    message: string;
    type: ErrorType;
    param: string | null;
    code: string;
    trace_id?: string;
    status_code: number;
    timestamp: string;
  };
}

function errorTypeForStatus(status: number): ErrorType {
  if (status === HttpStatus.UNAUTHORIZED) return 'authentication_error';
  if (status === HttpStatus.FORBIDDEN) return 'permission_error';
  if (status === HttpStatus.NOT_FOUND) return 'not_found_error';
  if (status === HttpStatus.CONFLICT) return 'conflict_error';
  if (status === HttpStatus.TOO_MANY_REQUESTS) return 'rate_limit_error';
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) return 'server_error';
  return 'invalid_request_error';
}

function defaultCodeForStatus(status: number): string {
  if (status === HttpStatus.UNAUTHORIZED) return ErrorCode.AUTHENTICATION_ERROR;
  if (status === HttpStatus.FORBIDDEN) return ErrorCode.AUTHORIZATION_ERROR;
  if (status === HttpStatus.NOT_FOUND) return ErrorCode.NOT_FOUND;
  if (status === HttpStatus.CONFLICT) return ErrorCode.EMAIL_ALREADY_EXISTS;
  if (status === HttpStatus.TOO_MANY_REQUESTS) return ErrorCode.RATE_LIMIT_ERROR;
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) return ErrorCode.INTERNAL_ERROR;
  return ErrorCode.VALIDATION_ERROR;
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

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ErrorCode.INTERNAL_ERROR;
    let message = 'Internal server error';
    let param: string | null = null;
    let traceId: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const responseBody = exception.getResponse();
      const body =
        typeof responseBody === 'string'
          ? { message: responseBody }
          : (responseBody as Record<string, unknown>);

      message = normalizeMessage(body.message) ?? exception.message;
      code =
        typeof body.code === 'string'
          ? body.code
          : defaultCodeForStatus(status);
      param = typeof body.param === 'string' ? body.param : null;
      traceId =
        (typeof body.trace_id === 'string' && body.trace_id) ||
        (typeof body.traceId === 'string' && body.traceId) ||
        undefined;
    } else if (exception instanceof Error) {
      // Do not expose internal error details to API clients.
      message = 'Internal server error';
    }

    if (!traceId) {
      const request = ctx.getRequest() as any;
      traceId = request.traceId ?? request.id;
    }

    const errorResponse: ErrorResponse = {
      error: {
        message,
        type: errorTypeForStatus(status),
        param,
        code,
        trace_id: traceId,
        status_code: status,
        timestamp: new Date().toISOString(),
      },
    };

    this.logger.error(
      `[${traceId}] ${code}: ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(status).send(errorResponse);
  }
}
