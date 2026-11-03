import { Injectable, Logger } from '@nestjs/common';
import { ChatCompletionRequest, ChatCompletionResponse } from '../router/schemas/chat-completion.schema';
import { ChatCompletionChunk, LLMProvider, ProviderOptions, ProviderResponse } from './base.provider';

@Injectable()
export class MockProvider extends LLMProvider {
  readonly name = 'mock';
  readonly requiresApiKey = false;
  private readonly logger = new Logger(MockProvider.name);

  async chatCompletion(
    request: ChatCompletionRequest,
    options: ProviderOptions,
    traceId: string,
  ): Promise<ProviderResponse> {
    const start = Date.now();

    // Simulate a simple echo response
    const lastMessage = request.messages[request.messages.length - 1];
    const content = lastMessage?.content ?? 'Hello from mock provider';

    const response: ChatCompletionResponse = {
      id: `chatcmpl_mock_${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `Mock response: ${content}`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: content.length,
        completion_tokens: content.length,
        total_tokens: content.length * 2,
      },
      trace_id: traceId,
    };

    const latencyMs = Date.now() - start;

    this.logger.log(
      `[${traceId}] Mock provider responded in ${latencyMs}ms`,
    );

    return {
      response,
      latencyMs,
      traceId,
    };
  }

  /**
   * Emits the same wording as the blocking response, one word at a time.
   *
   * The mock is what a developer without provider keys can test against, so its
   * stream has to exercise the real shape: a role delta, content deltas, then
   * a finish chunk carrying usage.
   */
  async *streamChatCompletion(
    request: ChatCompletionRequest,
    options: ProviderOptions,
    traceId: string,
  ): AsyncIterable<ChatCompletionChunk> {
    const lastMessage = request.messages[request.messages.length - 1];
    const prompt = lastMessage?.content ?? 'Hello from mock provider';
    const content = `Mock response: ${prompt}`;
    const id = `chatcmpl_mock_${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = {
      prompt_tokens: prompt.length,
      completion_tokens: content.length,
      total_tokens: prompt.length + content.length,
    };

    const chunk = (
      choices: ChatCompletionChunk['choices'],
      chunkUsage?: ChatCompletionChunk['usage'],
    ): ChatCompletionChunk => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: request.model,
      choices,
      ...(chunkUsage ? { usage: chunkUsage } : {}),
      trace_id: traceId,
    });

    yield chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);

    // Word-sized deltas: small enough to look live, large enough that a test or
    // a curl transcript stays readable.
    for (const word of content.match(/\S+\s*/g) ?? [content]) {
      if (options.signal?.aborted) {
        return;
      }

      yield chunk([{ index: 0, delta: { content: word }, finish_reason: null }]);
    }

    this.logger.log(`[${traceId}] Mock provider streamed ${content.length} characters`);

    yield chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], usage);
  }

  async healthCheck(options: ProviderOptions): Promise<boolean> {
    return true;
  }
}