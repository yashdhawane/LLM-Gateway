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

export type ProviderErrorCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_BAD_REQUEST'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ERROR';

export class ProviderError extends Error {
  readonly name = 'ProviderError';

  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly providerStatus?: number,
  ) {
    super(message);
  }
}

export abstract class LLMProvider {
  abstract readonly name: string;
  abstract readonly requiresApiKey: boolean;

  abstract chatCompletion(
    request: ChatCompletionRequest,
    options: ProviderOptions,
    traceId: string,
  ): Promise<ProviderResponse>;

  abstract healthCheck(options: ProviderOptions): Promise<boolean>;
}
