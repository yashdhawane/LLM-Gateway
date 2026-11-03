import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../router/schemas/chat-completion.schema';
import { readSseBlocks } from '../../common/sse/sse-parser';
import {
  ChatCompletionChunk,
  LLMProvider,
  ProviderOptions,
  ProviderResponse,
} from './base.provider';
import { parseOpenAiStreamPayload } from './openai.stream';
import {
  mapHttpProviderError,
  openEventStream,
  requestWithTimeout,
} from './provider-http';

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

  /**
   * Streams from an OpenAI-compatible endpoint.
   *
   * The upstream already emits the published chunk shape, so each event is
   * forwarded with only the trace id added. `[DONE]` ends the iterable.
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
          url: `${this.apiRoot(options)}/chat/completions`,
          data: {
            ...request,
            stream: true,
            // Always ask for usage so the request log has token counts even
            // when the client did not opt in. The gateway strips it from
            // content chunks and re-emits it only on request.
            stream_options: { include_usage: true },
          },
          headers: {
            Authorization: `Bearer ${options.apiKey ?? ''}`,
            'Content-Type': 'application/json',
            'X-Trace-Id': traceId,
          },
        },
        options.timeoutMs,
        options.signal,
      );

      for await (const block of readSseBlocks(stream)) {
        const chunk = parseOpenAiStreamPayload(block.data);

        if (chunk === null) {
          return;
        }

        yield { ...chunk, trace_id: traceId };
      }
    } catch (error) {
      const latencyMs = Date.now() - start;
      const err = error as Error;
      this.logger.error(
        `[${traceId}] OpenAI stream error after ${latencyMs}ms: ${err.message}`,
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
