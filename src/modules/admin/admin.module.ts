import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InsightsModule } from '../insights/insights.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [AuthModule, InsightsModule],
  controllers: [AdminController],
})
export class AdminModule {}
