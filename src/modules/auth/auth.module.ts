import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ApiKeyGuard } from './api-key.guard';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [AuthService, ApiKeyGuard],
  exports: [AuthService, ApiKeyGuard],
})
export class AuthModule {}
