import { Injectable, Logger } from '@nestjs/common';
import { ChatCompletionRequest, ChatCompletionResponse } from '../router/schemas/chat-completion.schema';
import { LLMProvider, ProviderOptions, ProviderResponse } from './base.provider';

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

  async healthCheck(options: ProviderOptions): Promise<boolean> {
    return true;
  }
}