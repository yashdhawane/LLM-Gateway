import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProviderService } from './provider.service';
import { CredentialManager } from './credential.manager';
import { ResilienceService } from './resilience.service';

@Module({
  imports: [HttpModule],
  providers: [ProviderService, CredentialManager, ResilienceService],
  exports: [ProviderService, CredentialManager, ResilienceService],
})
export class ProvidersModule {}
