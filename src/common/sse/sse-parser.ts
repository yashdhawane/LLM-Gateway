/**
 * Server-sent event parsing for provider responses.
 *
 * Providers send a stream of bytes, not a stream of events: a single read can
 * carry half a line, and one event can span several reads. The parser therefore
 * splits on blank lines across chunk boundaries and flushes a trailing block so
 * a truncated stream still surfaces what did arrive.
 */
export interface SseBlock {
  /** `event:` field, when the provider names its events (Anthropic does). */
  event: string | null;
  /** `data:` lines joined with a newline, exactly as the spec defines. */
  data: string;
}

const SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

export function parseSseBlock(block: string): SseBlock | null {
  let event: string | null = null;
  const data: string[] = [];

  for (const line of block.split(/\r\n|\n|\r/)) {
    // A blank line is a separator and a `:` line is a comment (keep-alive).
    if (line === '' || line.startsWith(':')) {
      continue;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    // The spec strips exactly one leading space from the value.
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;

    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      data.push(value);
    }
  }

  if (data.length === 0) {
    return null;
  }

  return { event, data: data.join('\n') };
}

export async function* readSseBlocks(
  source: AsyncIterable<string | Buffer>,
): AsyncIterable<SseBlock> {
  let buffer = '';

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    let match = SEPARATOR.exec(buffer);

    while (match) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);

      const block = parseSseBlock(raw);
      if (block) {
        yield block;
      }

      match = SEPARATOR.exec(buffer);
    }
  }

  // A stream that ends without a trailing blank line still has one last event.
  const block = parseSseBlock(buffer);
  if (block) {
    yield block;
  }
}
