import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ConfigService } from '@nestjs/config';
import pino from 'pino';

interface LogContext {
  traceId?: string;
  method?: string;
  url?: string;
  statusCode?: number;
  latencyMs?: number;
  userId?: string;
  provider?: string;
  model?: string;
  errorCode?: string;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger: pino.Logger;

  constructor(config: ConfigService) {
    this.logger = pino({
      level: config.get<string>('LOG_LEVEL', 'info'),
      redact: ['req.headers.authorization', 'req.body.api_key', 'res.body.api_key'],
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const start = Date.now();

    const traceId = request.traceId;
    const method = request.method;
    const url = request.url;
    const userId = request.user?.id;
    const provider = request.provider;
    const model = request.model;

    const logContext: LogContext = {
      traceId,
      method,
      url,
      userId,
      provider,
      model,
    };

    // Log incoming request without sensitive body content
    this.logger.info(
      { ...logContext, event: 'request_received' },
      'Request received',
    );

    return next.handle().pipe(
      tap({
        next: () => {
          const latencyMs = Date.now() - start;
          const response = context.switchToHttp().getResponse();
          logContext.statusCode = response.statusCode;
          logContext.latencyMs = latencyMs;

          this.logger.info(
            { ...logContext, event: 'request_completed' },
            'Request completed',
          );
        },
        error: (err: any) => {
          const latencyMs = Date.now() - start;
          logContext.statusCode = err?.status ?? 500;
          logContext.latencyMs = latencyMs;
          logContext.errorCode = err?.code;

          this.logger.error(
            { ...logContext, event: 'request_failed' },
            'Request failed',
          );
        },
      }),
    );
  }
}