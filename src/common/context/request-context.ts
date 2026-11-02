/**
 * Request-scoped context shared by the gateway lifecycle.
 *
 * Deliberately framework-free: no NestJS, no Prisma. The controller builds the
 * input from the authenticated user, the request headers and the parsed body,
 * then hands the immutable result to the services that need it.
 */

export interface RequestContextUser {
  id: string;
  apiKeyId: string | null;
}

export interface RequestContext {
  readonly traceId: string;
  readonly requestId: string;
  readonly userId: string;
  readonly apiKeyId: string | null;
  readonly requestedModel: string;
  readonly isStream: boolean;
  readonly startedAt: Date;
}

export interface CreateRequestContextInput {
  traceId: string;
  requestId: string;
  user: RequestContextUser;
  requestedModel: string;
  isStream?: boolean;
  now?: Date;
}

/**
 * Builds the frozen request context. `userId` is the only user field kept: a
 * copy of the parent request-log row id intentionally lives elsewhere.
 */
export function createRequestContext(
  input: CreateRequestContextInput,
): RequestContext {
  return Object.freeze({
    traceId: input.traceId,
    requestId: input.requestId,
    userId: input.user.id,
    apiKeyId: input.user.apiKeyId ?? null,
    requestedModel: input.requestedModel,
    isStream: input.isStream === true,
    startedAt: input.now ?? new Date(),
  });
}

/** Returns `body.model` when it is a non-empty string, otherwise `'unknown'`. */
export function requestedModelFromBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return 'unknown';
  }

  const model = (body as Record<string, unknown>).model;
  if (typeof model !== 'string' || model.length === 0) {
    return 'unknown';
  }

  return model;
}
