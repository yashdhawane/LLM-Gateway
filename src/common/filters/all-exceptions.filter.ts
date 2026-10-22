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
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR = 'AUTHORIZATION_ERROR',
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  PROVIDER_TIMEOUT = 'PROVIDER_TIMEOUT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
  API_KEY_INVALID = 'API_KEY_INVALID',
  API_KEY_INACTIVE = 'API_KEY_INACTIVE',
}

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    traceId?: string;
    statusCode: number;
    timestamp: string;
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = ErrorCode.INTERNAL_ERROR;
    let message = 'Internal server error';
    let traceId: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const responseBody = exception.getResponse() as any;
      message = responseBody.message || exception.message;
      code = responseBody.code || ErrorCode.INTERNAL_ERROR;
      traceId = responseBody.traceId;
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (!traceId) {
      traceId = (ctx.getRequest() as any).traceId;
    }

    const errorResponse: ErrorResponse = {
      error: {
        code,
        message,
        traceId,
        statusCode: status,
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