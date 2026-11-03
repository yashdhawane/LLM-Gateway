import {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../router/schemas/chat-completion.schema';
import type { SseBlock } from '../../common/sse/sse-parser';
import {
  ChatCompletionChunk,
  ProviderError,
} from './base.provider';

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

  const finishReason = mapStopReason(response.stop_reason);

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

/** Anthropic stop reasons in the OpenAI vocabulary the gateway publishes. */
export function mapStopReason(stopReason: string | null | undefined): string {
  if (stopReason === 'max_tokens') {
    return 'length';
  }

  if (stopReason === 'tool_use') {
    return 'tool_calls';
  }

  return 'stop';
}

/**
 * State carried across the events of one Anthropic stream.
 *
 * Anthropic identifies the message once, in `message_start`, and reports input
 * tokens there and output tokens at the end, so each event needs what the
 * previous ones established.
 */
export interface AnthropicStreamState {
  id: string;
  model: string;
  created: number;
  promptTokens?: number;
}

export function createAnthropicStreamState(
  fallbackModel: string,
): AnthropicStreamState {
  return {
    id: `chatcmpl_anthropic_${Date.now()}`,
    model: fallbackModel,
    created: Math.floor(Date.now() / 1000),
  };
}

interface AnthropicStreamEvent {
  type?: string;
  message?: AnthropicResponse;
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string | null;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Translates one Anthropic stream event into zero or more OpenAI chunks.
 *
 * Anthropic names its events and splits the message across several of them;
 * the OpenAI format the gateway publishes has a single shape for every event,
 * so `message_start` becomes the role delta, `content_block_delta` the text,
 * and `message_delta` the finish reason plus usage.
 */
export function toChatCompletionChunks(
  block: SseBlock,
  state: AnthropicStreamState,
): ChatCompletionChunk[] {
  let event: AnthropicStreamEvent;

  try {
    event = JSON.parse(block.data) as AnthropicStreamEvent;
  } catch {
    throw new ProviderError(
      'PROVIDER_ERROR',
      'The provider sent a malformed stream event.',
    );
  }

  if (typeof event !== 'object' || event === null) {
    throw new ProviderError(
      'PROVIDER_ERROR',
      'The provider sent a malformed stream event.',
    );
  }

  const chunk = (
    choices: ChatCompletionChunk['choices'],
    usage?: ChatCompletionChunk['usage'],
  ): ChatCompletionChunk => ({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices,
    ...(usage ? { usage } : {}),
  });

  switch (event.type) {
    case 'message_start': {
      const message = event.message ?? {};
      state.id = message.id ?? state.id;
      state.model = message.model ?? state.model;
      state.promptTokens = message.usage?.input_tokens;

      return [
        chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]),
      ];
    }

    case 'content_block_delta': {
      const text = event.delta?.type === 'text_delta' ? event.delta.text : undefined;

      if (typeof text !== 'string' || text === '') {
        return [];
      }

      return [chunk([{ index: 0, delta: { content: text }, finish_reason: null }])];
    }

    case 'message_delta': {
      const completionTokens = event.usage?.output_tokens;
      const usage =
        completionTokens === undefined
          ? undefined
          : {
              prompt_tokens: state.promptTokens,
              completion_tokens: completionTokens,
              total_tokens: (state.promptTokens ?? 0) + completionTokens,
            };

      return [
        chunk(
          [
            {
              index: 0,
              delta: {},
              finish_reason: mapStopReason(event.delta?.stop_reason),
            },
          ],
          usage,
        ),
      ];
    }

    // `ping`, `content_block_start/stop` and `message_stop` carry nothing the
    // OpenAI format has a place for.
    default:
      return [];
  }
}
