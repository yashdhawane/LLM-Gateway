import { Module } from '@nestjs/common';
import { GatewayController } from './gateway.controller';
import { RouterModule } from '../router/router.module';
import { ProvidersModule } from '../providers/providers.module';
import { AuthModule } from '../auth/auth.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [RouterModule, ProvidersModule, AuthModule, TelemetryModule, PrismaModule],
  controllers: [GatewayController],
  providers: [],
  exports: [],
})
export class GatewayModule {}
