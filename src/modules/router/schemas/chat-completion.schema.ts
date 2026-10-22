import { z } from 'zod';

// OpenAI-compatible chat completion request
export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool', 'function']),
      content: z.string().optional(),
      tool_calls: z.any().optional(),
      tool_call_id: z.string().optional(),
    }),
  ),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().min(1).max(128).optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  user: z.string().optional(),
  // Gateway-specific headers/options
  timeout: z.number().positive().optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

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
    code: z.string(),
    message: z.string(),
    trace_id: z.string().optional(),
    status_code: z.number(),
    timestamp: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;