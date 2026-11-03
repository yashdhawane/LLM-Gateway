import type { SseErrorPayload } from './sse-frame';

/**
 * The gateway's only view of the response while streaming.
 *
 * Kept as an interface so the gateway can be tested without a socket, and so
 * the transport (Fastify today) never leaks into the streaming logic. Every
 * method is total: a dead socket must not throw back into the gateway.
 */
export interface StreamSink {
  /** True once the 200 and the SSE headers have been written. */
  readonly isOpen: boolean;
  /** True once the client has gone away; providers are aborted from it. */
  readonly aborted: boolean;
  /** Aborts on client disconnect. Passed to the provider so it stops billing. */
  readonly signal: AbortSignal;
  /** Commits the response. Idempotent. */
  open(): void;
  /** Writes one `data:` frame. Resolves after backpressure is relieved. */
  write(payload: unknown): Promise<void>;
  /** Writes the terminal `[DONE]` frame and closes the response. */
  end(): void;
  /** Writes an error frame instead of `[DONE]` and closes the response. */
  fail(payload: SseErrorPayload): void;
}
