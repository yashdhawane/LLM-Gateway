import { z } from 'zod';

const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'developer']),
  content: z.string(),
  name: z.string().min(1).max(256).optional(),
});

// OpenAI-compatible chat completion request, restricted to the features this
// gateway can currently guarantee. Unsupported fields are rejected explicitly
// instead of being silently dropped or passed through to a provider.
export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().min(1).max(128).optional(),
  stream: z.boolean().optional(),
  stop: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(4)])
    .optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  logit_bias: z.record(z.string(), z.number().min(-100).max(100)).optional(),
  user: z.string().min(1).max(256).optional(),
  seed: z.number().int().optional(),
  // Gateway-specific option; removed before the provider request is sent.
  timeout: z.number().positive().optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export class ChatRequestValidationError extends Error {
  constructor(
    message: string,
    public readonly code: 'VALIDATION_ERROR' | 'UNSUPPORTED_FEATURE',
    public readonly param?: string,
  ) {
    super(message);
    this.name = 'ChatRequestValidationError';
  }
}

const SUPPORTED_FIELDS = new Set([
  'model',
  'messages',
  'temperature',
  'top_p',
  'n',
  'stream',
  'stop',
  'max_tokens',
  'max_completion_tokens',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'user',
  'seed',
  'timeout',
]);

const SUPPORTED_MESSAGE_FIELDS = new Set(['role', 'content', 'name']);

const UNSUPPORTED_FIELDS = [
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'functions',
  'function_call',
  'response_format',
  'stream_options',
  'logprobs',
  'top_logprobs',
  'modalities',
  'audio',
  'prediction',
  'reasoning_effort',
  'store',
  'metadata',
  'service_tier',
  'verbosity',
  'web_search_options',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unsupported(param: string, message: string) {
  return new ChatRequestValidationError(message, 'UNSUPPORTED_FEATURE', param);
}

/**
 * Validates a chat request and turns unsupported OpenAI features into a stable,
 * machine-readable error instead of letting them fail inside a provider.
 */
export function validateChatCompletionRequest(
  input: unknown,
): ChatCompletionRequest {
  if (!isRecord(input)) {
    throw new ChatRequestValidationError(
      'Request body must be a JSON object.',
      'VALIDATION_ERROR',
    );
  }

  for (const field of UNSUPPORTED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw unsupported(
        field,
        `The '${field}' field is not supported by this gateway.`,
      );
    }
  }

  const unknownField = Object.keys(input).find(
    (field) => !SUPPORTED_FIELDS.has(field),
  );
  if (unknownField) {
    throw unsupported(
      unknownField,
      `Unsupported request field '${unknownField}'.`,
    );
  }

  if (input.stream === true) {
    throw unsupported(
      'stream',
      'Streaming is not supported yet. Set stream to false or omit it.',
    );
  }

  if (typeof input.n === 'number' && Number.isInteger(input.n) && input.n > 1) {
    throw unsupported('n', 'Only one completion per request is supported.');
  }

  if (Array.isArray(input.messages)) {
    for (const [index, message] of input.messages.entries()) {
      if (!isRecord(message)) {
        continue;
      }

      const prefix = `messages.${index}`;
      if (message.role === 'tool' || message.role === 'function') {
        throw unsupported(
          `${prefix}.role`,
          'Tool and function messages are not supported yet.',
        );
      }

      if (Array.isArray(message.content) || isRecord(message.content)) {
        throw unsupported(
          `${prefix}.content`,
          'Multimodal content is not supported yet. Use a text string.',
        );
      }

      const unknownMessageField = Object.keys(message).find(
        (field) => !SUPPORTED_MESSAGE_FIELDS.has(field),
      );
      if (unknownMessageField) {
        throw unsupported(
          `${prefix}.${unknownMessageField}`,
          `Unsupported message field '${unknownMessageField}'.`,
        );
      }
    }
  }

  const parsed = ChatCompletionRequestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const param = issue.path.length ? issue.path.join('.') : undefined;
    const message = param
      ? `Invalid '${param}': ${issue.message}`
      : issue.message;

    throw new ChatRequestValidationError(message, 'VALIDATION_ERROR', param);
  }

  return parsed.data;
}

// OpenAI-compatible chat completion response
export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: z.object({
        role: z.string(),
        content: z.string().optional(),
        tool_calls: z.any().optional(),
      }),
      finish_reason: z.string().nullable(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
  // Gateway-specific trace ID
  trace_id: z.string().optional(),
});

export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;

// Error response
export const ErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable(),
    code: z.string(),
    trace_id: z.string().optional(),
    status_code: z.number(),
    timestamp: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
