import { Module, Injectable } from '@nestjs/common';
import { ProviderService } from './provider.service';
import { OpenAIProvider } from './openai.provider';
import { MockProvider } from './mock.provider';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [HttpModule],
  providers: [ProviderService, OpenAIProvider, MockProvider],
  exports: [ProviderService],
})
export class ProvidersModule {}