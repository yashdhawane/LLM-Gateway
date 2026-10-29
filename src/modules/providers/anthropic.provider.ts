import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../router/schemas/chat-completion.schema';
import {
  LLMProvider,
  ProviderOptions,
  ProviderResponse,
} from './base.provider';
import {
  AnthropicResponse,
  toAnthropicRequest,
  toChatCompletionResponse,
} from './anthropic.mapper';
import { mapHttpProviderError, requestWithTimeout } from './provider-http';

const ANTHROPIC_VERSION = '2023-06-01';

@Injectable()
export class AnthropicProvider extends LLMProvider {
  readonly name = 'anthropic';
  readonly requiresApiKey = true;
  private readonly logger = new Logger(AnthropicProvider.name);

  constructor(private readonly httpService: HttpService) {
    super();
  }

  async chatCompletion(
    request: ChatCompletionRequest,
    options: ProviderOptions,
    traceId: string,
  ): Promise<ProviderResponse> {
    const start = Date.now();

    try {
      const response = await requestWithTimeout<AnthropicResponse>(
        this.httpService,
        {
          method: 'POST',
          url: `${this.apiRoot(options)}/messages`,
          data: toAnthropicRequest(request),
          headers: {
            'x-api-key': options.apiKey ?? '',
            'anthropic-version': ANTHROPIC_VERSION,
            'Content-Type': 'application/json',
            'X-Trace-Id': traceId,
          },
        },
        options.timeoutMs,
      );

      return {
        response: toChatCompletionResponse(
          response.data,
          request.model,
          traceId,
        ),
        latencyMs: Date.now() - start,
        traceId,
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      const err = error as Error;
      this.logger.error(
        `[${traceId}] Anthropic provider error after ${latencyMs}ms: ${err.message}`,
        err.stack,
      );
      throw mapHttpProviderError(error, 'anthropic');
    }
  }

  async healthCheck(options: ProviderOptions): Promise<boolean> {
    try {
      await requestWithTimeout(
        this.httpService,
        {
          method: 'GET',
          url: `${this.apiRoot(options)}/models`,
          headers: {
            'x-api-key': options.apiKey ?? '',
            'anthropic-version': ANTHROPIC_VERSION,
          },
        },
        5000,
      );
      return true;
    } catch {
      return false;
    }
  }

  private apiRoot(options: ProviderOptions): string {
    const base = (options.baseUrl ?? 'https://api.anthropic.com').replace(
      /\/+$/,
      '',
    );
    return base.endsWith('/v1') ? base : `${base}/v1`;
  }
}
