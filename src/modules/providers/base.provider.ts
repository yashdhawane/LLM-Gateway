import type { RequestContext } from '../../common/context/request-context';
import { ChatCompletionRequest, ChatCompletionResponse } from '../router/schemas/chat-completion.schema';

export interface ProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  /**
   * Aborts the upstream request.
   *
   * For a streaming request this stays meaningful after the headers arrive: it
   * destroys the socket, which is how a client disconnect or an idle timeout
   * stops a provider that has already started talking.
   */
  signal?: AbortSignal;
  /**
   * Request-scoped context, for adapters that need it.
   *
   * Optional and additive: `chatCompletion`'s signature is unchanged.
   */
  context?: RequestContext;
}

export interface ProviderResponse {
  response: ChatCompletionResponse;
  latencyMs: number;
  traceId: string;
}

/** One event of an OpenAI-compatible streamed completion. */
export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  trace_id?: string;
}

export type ProviderErrorCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_BAD_REQUEST'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_NOT_CONFIGURED'
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

  /**
   * Streams a completion, one OpenAI-compatible chunk at a time.
   *
   * Optional: a provider that cannot stream simply omits it, and the gateway
   * answers `UNSUPPORTED_FEATURE` instead of pretending. The iterable must stop
   * when `options.signal` aborts, so an abandoned client cannot keep billing an
   * upstream call.
   */
  streamChatCompletion?(
    request: ChatCompletionRequest,
    options: ProviderOptions,
    traceId: string,
  ): AsyncIterable<ChatCompletionChunk>;

  abstract healthCheck(options: ProviderOptions): Promise<boolean>;
}
