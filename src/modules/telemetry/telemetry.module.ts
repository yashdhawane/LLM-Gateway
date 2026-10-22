import { Module, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  logRequest(event: {
    traceId: string;
    userId: string;
    apiKeyId?: string;
    modelId?: string;
    provider?: string;
    statusCode: number;
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cost?: number;
    errorCode?: string;
    errorMessage?: string;
  }) {
    this.logger.log(
      `[${event.traceId}] Request logged: ${event.statusCode} ${event.latencyMs}ms`,
    );

    this.eventEmitter.emit('request.logged', event);
  }

  logError(event: {
    traceId: string;
    errorCode: string;
    errorMessage: string;
    statusCode: number;
  }) {
    this.logger.error(
      `[${event.traceId}] Error logged: ${event.errorCode} - ${event.errorMessage}`,
    );

    this.eventEmitter.emit('error.logged', event);
  }
}

@Module({
  providers: [TelemetryService],
  exports: [TelemetryService],
})
export class TelemetryModule {}