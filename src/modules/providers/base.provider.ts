import { ChatCompletionRequest, ChatCompletionResponse } from '../router/schemas/chat-completion.schema';

export interface ProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface ProviderResponse {
  response: ChatCompletionResponse;
  latencyMs: number;
  traceId: string;
}

export abstract class LLMProvider {
  abstract readonly name: string;

  abstract chatCompletion(
    request: ChatCompletionRequest,
    options: ProviderOptions,
    traceId: string,
  ): Promise<ProviderResponse>;

  abstract healthCheck(options: ProviderOptions): Promise<boolean>;
}