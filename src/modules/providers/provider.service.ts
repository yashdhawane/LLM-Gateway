import { Injectable, Logger, Inject } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { OpenAIProvider } from './openai.provider';
import { AnthropicProvider } from './anthropic.provider';
import { MockProvider } from './mock.provider';
import {
  LLMProvider,
  ProviderError,
  ProviderOptions,
  ProviderResponse,
} from './base.provider';
import { ChatCompletionRequest } from '../router/schemas/chat-completion.schema';

@Injectable()
export class ProviderService {
  private readonly logger = new Logger(ProviderService.name);
  private providers = new Map<string, LLMProvider>();

  constructor(
    @Inject(HttpService) private readonly httpService: HttpService,
  ) {
    this.registerProvider(new MockProvider());
    this.registerProvider(new OpenAIProvider(this.httpService));
    this.registerProvider(new AnthropicProvider(this.httpService));
  }

  registerProvider(provider: LLMProvider) {
    this.providers.set(provider.name, provider);
    this.logger.log(`Registered provider: ${provider.name}`);
  }

  getProvider(name: string): LLMProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new ProviderError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider '${name}' is not registered.`,
      );
    }
    return provider;
  }

  async chatCompletion(
    providerName: string,
    request: ChatCompletionRequest,
    options: ProviderOptions,
    traceId: string,
  ): Promise<ProviderResponse> {
    const provider = this.getProvider(providerName);
    return provider.chatCompletion(request, options, traceId);
  }

  async healthCheck(
    providerName: string,
    options: ProviderOptions,
  ): Promise<boolean> {
    const provider = this.getProvider(providerName);
    return provider.healthCheck(options);
  }
}
