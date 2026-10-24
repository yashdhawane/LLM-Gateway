import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { validateEnv } from './config/env';
import { AuthModule } from './modules/auth/auth.module';
import { RouterModule } from './modules/router/router.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { TelemetryModule } from './modules/telemetry/telemetry.module';
import { SpendModule } from './modules/spend/spend.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { InsightsModule } from './modules/insights/insights.module';
import { AdminModule } from './modules/admin/admin.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: '.env',
      validate: validateEnv,
      skipProcessEnv: true,
    }),
    EventEmitterModule.forRoot(),
    PrismaModule,
    AuthModule,
    RouterModule,
    ProvidersModule,
    GatewayModule,
    TelemetryModule,
    SpendModule,
    InsightsModule,
    AdminModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}