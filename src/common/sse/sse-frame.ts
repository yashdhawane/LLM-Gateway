import type { ErrorType } from '../errors/error-taxonomy';

/**
 * Server-sent event framing.
 *
 * A frame is one `data:` line plus a blank line. `JSON.stringify` never emits a
 * raw newline, so a payload cannot accidentally terminate its own frame.
 */
export const SSE_DONE_FRAME = 'data: [DONE]\n\n';

export function toSseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export interface SseErrorPayload {
  code: string;
  message: string;
  type?: ErrorType;
  param?: string | null;
  traceId?: string;
  statusCode?: number;
  timestamp?: string;
}

/**
 * An error that happens after the response is open.
 *
 * The HTTP status is already committed (200), so the failure travels as an
 * event with the same envelope a JSON error response would have carried. The
 * client must treat a stream that ends with this frame as failed.
 */
export function toSseErrorFrame(payload: SseErrorPayload): string {
  return toSseFrame({
    error: {
      message: payload.message,
      type: payload.type ?? 'server_error',
      param: payload.param ?? null,
      code: payload.code,
      trace_id: payload.traceId,
      status_code: payload.statusCode ?? 500,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    },
  });
}
