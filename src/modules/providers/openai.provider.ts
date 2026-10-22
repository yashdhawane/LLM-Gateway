import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ChatCompletionRequest, ChatCompletionResponse } from '../router/schemas/chat-completion.schema';
import { LLMProvider, ProviderOptions, ProviderResponse } from './base.provider';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable()
export class OpenAIProvider extends LLMProvider {
  readonly name = 'openai';
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
    const url = `${options.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`;

    try {
      const response = await firstValueFrom(
        this.httpService.post(url, request, {
          headers: {
            'Authorization': `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            'X-Trace-Id': traceId,
          },
        }).pipe(timeout(options.timeoutMs)),
      );

      const latencyMs = Date.now() - start;
      const providerResponse: ChatCompletionResponse = {
        ...response.data,
        trace_id: traceId,
      };

      return {
        response: providerResponse,
        latencyMs,
        traceId,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - start;
      this.logger.error(
        `[${traceId}] OpenAI provider error after ${latencyMs}ms: ${error.message}`,
        error.stack,
      );

      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        throw new Error('PROVIDER_TIMEOUT');
      }

      throw new Error(`PROVIDER_ERROR: ${error.message}`);
    }
  }

  async healthCheck(options: ProviderOptions): Promise<boolean> {
    try {
      const url = `${options.baseUrl ?? 'https://api.openai.com'}/v1/models`;
      await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            'Authorization': `Bearer ${options.apiKey}`,
          },
        }).pipe(timeout(5000)),
      );
      return true;
    } catch {
      return false;
    }
  }
}