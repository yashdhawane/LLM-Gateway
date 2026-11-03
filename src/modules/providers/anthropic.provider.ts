import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../router/schemas/chat-completion.schema';
import {
  ChatCompletionChunk,
  LLMProvider,
  ProviderError,
  ProviderOptions,
  ProviderResponse,
} from './base.provider';
import {
  AnthropicResponse,
  createAnthropicStreamState,
  toAnthropicRequest,
  toChatCompletionChunks,
  toChatCompletionResponse,
} from './anthropic.mapper';
import { readSseBlocks } from '../../common/sse/sse-parser';
import {
  mapHttpProviderError,
  openEventStream,
  requestWithTimeout,
} from './provider-http';

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

  /**
   * Streams the Anthropic Messages API, translated to OpenAI chunks.
   *
   * Anthropic names its events and splits one message across several of them,
   * so `toChatCompletionChunks` carries the state. An `error` event arrives
   * mid-stream with HTTP 200 already sent, which is why it becomes a
   * `ProviderError` the gateway reports in an SSE frame rather than a retry.
   */
  async *streamChatCompletion(
    request: ChatCompletionRequest,
    options: ProviderOptions,
    traceId: string,
  ): AsyncIterable<ChatCompletionChunk> {
    const start = Date.now();

    try {
      const stream = await openEventStream(
        this.httpService,
        {
          method: 'POST',
          url: `${this.apiRoot(options)}/messages`,
          data: { ...toAnthropicRequest(request), stream: true },
          headers: {
            'x-api-key': options.apiKey ?? '',
            'anthropic-version': ANTHROPIC_VERSION,
            'Content-Type': 'application/json',
            'X-Trace-Id': traceId,
          },
        },
        options.timeoutMs,
        options.signal,
      );

      const state = createAnthropicStreamState(request.model);

      for await (const block of readSseBlocks(stream)) {
        if (block.event === 'error') {
          throw new ProviderError(
            'PROVIDER_ERROR',
            'The provider reported an error mid-stream.',
          );
        }

        for (const chunk of toChatCompletionChunks(block, state)) {
          yield { ...chunk, trace_id: traceId };
        }
      }
    } catch (error) {
      const latencyMs = Date.now() - start;
      const err = error as Error;

      this.logger.error(
        `[${traceId}] Anthropic stream error after ${latencyMs}ms: ${err.message}`,
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
