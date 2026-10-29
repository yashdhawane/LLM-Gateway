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
import { mapHttpProviderError, requestWithTimeout } from './provider-http';

@Injectable()
export class OpenAIProvider extends LLMProvider {
  readonly name = 'openai';
  readonly requiresApiKey = true;
  private readonly logger = new Logger(OpenAIProvider.name);

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
      const response = await requestWithTimeout<ChatCompletionResponse>(
        this.httpService,
        {
          method: 'POST',
          url: `${this.apiRoot(options)}/chat/completions`,
          data: request,
          headers: {
            Authorization: `Bearer ${options.apiKey ?? ''}`,
            'Content-Type': 'application/json',
            'X-Trace-Id': traceId,
          },
        },
        options.timeoutMs,
      );

      return {
        response: {
          ...response.data,
          trace_id: traceId,
        },
        latencyMs: Date.now() - start,
        traceId,
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      const err = error as Error;
      this.logger.error(
        `[${traceId}] OpenAI provider error after ${latencyMs}ms: ${err.message}`,
        err.stack,
      );
      throw mapHttpProviderError(error, 'openai');
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
            Authorization: `Bearer ${options.apiKey ?? ''}`,
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
    const base = (options.baseUrl ?? 'https://api.openai.com').replace(
      /\/+$/,
      '',
    );
    return base.endsWith('/v1') ? base : `${base}/v1`;
  }
}
