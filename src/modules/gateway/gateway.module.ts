import { Module } from '@nestjs/common';
import { GatewayController } from './gateway.controller';
import { ModelsController } from './models.controller';
import { RouterModule } from '../router/router.module';
import { ProvidersModule } from '../providers/providers.module';
import { AuthModule } from '../auth/auth.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { GatewayService } from './gateway.service';

@Module({
  imports: [RouterModule, ProvidersModule, AuthModule, TelemetryModule, PrismaModule],
  controllers: [GatewayController, ModelsController],
  providers: [GatewayService],
  exports: [],
})
export class GatewayModule {}
