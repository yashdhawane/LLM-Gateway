import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { RequestLogService } from './request-log.service';

/**
 * `TelemetryModule` is not `@Global` (unlike `PrismaModule`), so it must be
 * imported here or Nest cannot resolve `RequestLogService`'s second
 * constructor parameter at boot (§5.9).
 */
@Module({
  imports: [TelemetryModule],
  providers: [RequestLogService],
  exports: [RequestLogService],
})
export class RequestLogModule {}
