import type { FastifyReply } from 'fastify';
import type { ServerResponse } from 'node:http';
import {
  SSE_DONE_FRAME,
  toSseErrorFrame,
  toSseFrame,
  type SseErrorPayload,
} from './sse-frame';
import type { StreamSink } from './stream-sink';

/**
 * Fastify transport for a streamed completion.
 *
 * `reply.hijack()` takes the response away from Fastify: the SDK would
 * otherwise try to send its own JSON after the handler returns, which is
 * exactly what a committed SSE response must prevent.
 *
 * `reply.getHeaders()` is merged in because Fastify has already collected the
 * CORS and trace headers by the time the first chunk arrives. Writing headers
 * straight to the socket without them would make a browser reject a response
 * `curl` accepts.
 *
 * Client disconnect is detected through the response's `close` event. Node
 * emits it after a normal end too, so `finished` is set before `end()` and the
 * abort signal is only raised for a genuinely premature close.
 */
export function createFastifyStreamSink(
  reply: FastifyReply,
  traceId: string,
): StreamSink {
  const controller = new AbortController();
  let open = false;
  let finished = false;

  reply.raw.on('close', () => {
    if (!finished) {
      finished = true;
      controller.abort();
    }
  });

  return {
    get isOpen() {
      return open;
    },
    get aborted() {
      return controller.signal.aborted;
    },
    signal: controller.signal,

    open() {
      if (open || finished) {
        return;
      }

      reply.hijack();

      const headers = reply.getHeaders() as Record<
        string,
        string | string[] | number | undefined
      >;

      reply.raw.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // nginx buffers proxied responses by default, which turns a stream into
        // one large response at the very end.
        'x-accel-buffering': 'no',
        'x-trace-id': traceId,
      });

      open = true;
    },

    async write(payload) {
      if (!open || finished) {
        return;
      }

      if (reply.raw.write(toSseFrame(payload)) === false) {
        await drain(reply.raw, controller.signal);
      }
    },

    end() {
      if (!open || finished) {
        return;
      }

      // Marked before writing so the `close` that follows is not mistaken for
      // a client that went away.
      finished = true;
      writeSafely(reply.raw, SSE_DONE_FRAME);
      endSafely(reply.raw);
    },

    fail(payload) {
      if (!open || finished) {
        return;
      }

      finished = true;
      writeSafely(
        reply.raw,
        toSseErrorFrame({ ...payload, traceId: payload.traceId ?? traceId }),
      );
      endSafely(reply.raw);
    },
  };
}

/**
 * Resolves when the socket accepts more data, or immediately when it is closed
 * or aborted. Never rejects: a broken client is a normal end of a stream.
 */
function drain(raw: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || raw.destroyed || raw.writableEnded) {
      resolve();
      return;
    }

    const done = () => {
      raw.off('drain', done);
      raw.off('close', done);
      signal.removeEventListener('abort', done);
      resolve();
    };

    raw.once('drain', done);
    raw.once('close', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

function writeSafely(raw: ServerResponse, chunk: string): void {
  try {
    raw.write(chunk);
  } catch {
    // A write after the peer vanished is an expected outcome, not a failure of
    // the request: the client already has what it has.
  }
}

function endSafely(raw: ServerResponse): void {
  try {
    raw.end();
  } catch {
    // Same as `writeSafely`.
  }
}
