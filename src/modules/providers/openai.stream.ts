import { ChatCompletionChunk, ProviderError } from './base.provider';

/**
 * Parses one `data:` payload from an OpenAI-compatible stream.
 *
 * `[DONE]` is the terminator, not a chunk. Anything else is forwarded as-is:
 * the upstream already speaks `chat.completion.chunk`, so re-serialising it
 * would only risk dropping a field this gateway does not know about.
 *
 * A malformed payload is a provider failure, not something to skip silently: a
 * dropped chunk is a hole in the text the user is reading.
 */
export function parseOpenAiStreamPayload(
  data: string,
): ChatCompletionChunk | null {
  if (data.trim() === '[DONE]') {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ProviderError(
      'PROVIDER_ERROR',
      'The provider sent a malformed stream event.',
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProviderError(
      'PROVIDER_ERROR',
      'The provider sent a malformed stream event.',
    );
  }

  return parsed as ChatCompletionChunk;
}
