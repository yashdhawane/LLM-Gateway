import {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../router/schemas/chat-completion.schema';
import { ProviderError } from './base.provider';

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  metadata?: { user_id: string };
}

export interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Translate the gateway's canonical OpenAI-style request into Anthropic's
 * Messages API shape. Parameters Anthropic cannot honor are rejected rather
 * than silently dropped, so the public contract stays predictable.
 */
export function toAnthropicRequest(
  request: ChatCompletionRequest,
): AnthropicRequest {
  const unsupported: string[] = [];
  if (request.presence_penalty !== undefined) {
    unsupported.push('presence_penalty');
  }
  if (request.frequency_penalty !== undefined) {
    unsupported.push('frequency_penalty');
  }
  if (request.logit_bias && Object.keys(request.logit_bias).length > 0) {
    unsupported.push('logit_bias');
  }
  if (request.seed !== undefined) {
    unsupported.push('seed');
  }
  request.messages.forEach((message, index) => {
    if (message.name !== undefined) {
      unsupported.push(`messages[${index}].name`);
    }
  });

  if (unsupported.length > 0) {
    throw new ProviderError(
      'PROVIDER_BAD_REQUEST',
      `Anthropic does not support: ${unsupported.join(', ')}`,
    );
  }

  const system = request.messages
    .filter(
      (message) =>
        message.role === 'system' || message.role === 'developer',
    )
    .map((message) => message.content)
    .filter(Boolean)
    .join('\n\n');

  const messages: AnthropicMessage[] = request.messages
    .filter(
      (message) => message.role === 'user' || message.role === 'assistant',
    )
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }));

  if (messages.length === 0) {
    throw new ProviderError(
      'PROVIDER_BAD_REQUEST',
      'Anthropic requires at least one user or assistant message.',
    );
  }

  const stopSequences = request.stop
    ? Array.isArray(request.stop)
      ? request.stop
      : [request.stop]
    : undefined;
  const usableStopSequences =
    stopSequences && stopSequences.length > 0 ? stopSequences : undefined;

  return {
    model: request.model,
    max_tokens: request.max_completion_tokens ?? request.max_tokens ?? 1024,
    messages,
    ...(system ? { system } : {}),
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(usableStopSequences
      ? { stop_sequences: usableStopSequences }
      : {}),
    ...(request.user ? { metadata: { user_id: request.user } } : {}),
  };
}

/**
 * Normalize Anthropic's response into the same ChatCompletionResponse used by
 * every other provider.
 */
export function toChatCompletionResponse(
  response: AnthropicResponse,
  fallbackModel: string,
  traceId: string,
): ChatCompletionResponse {
  const text = (response.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');

  const finishReason =
    response.stop_reason === 'max_tokens'
      ? 'length'
      : response.stop_reason === 'tool_use'
        ? 'tool_calls'
        : 'stop';

  const usage = response.usage
    ? {
        prompt_tokens: response.usage.input_tokens ?? 0,
        completion_tokens: response.usage.output_tokens ?? 0,
        total_tokens:
          (response.usage.input_tokens ?? 0) +
          (response.usage.output_tokens ?? 0),
      }
    : undefined;

  return {
    id: response.id ?? `chatcmpl_anthropic_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model ?? fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: finishReason,
      },
    ],
    usage,
    trace_id: traceId,
  };
}
