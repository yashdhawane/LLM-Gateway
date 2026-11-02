import type { Prisma } from '@prisma/client';
import {
  deriveLatencySplit,
  type AttemptObservation,
} from '../../common/observability/attempt-observation';
import type { FailureClass } from '../../common/errors/error-taxonomy';

export type RequestLogStatus = 'PROCESSING' | 'SUCCESS' | 'FAILED';
export type AttemptStatus = 'SUCCEEDED' | 'FAILED';

/** Everything known when the PROCESSING row is created (§6.1). */
export interface StartRequestLogInput {
  traceId: string;
  requestId: string;
  userId: string;
  apiKeyId: string | null;
  requestedModel: string;
  isStream?: boolean;
  startedAt: Date;
}

/**
 * A full `RequestAttempt` row.
 *
 * Reserved fields (`retryAfterMs`, `timeToFirstTokenMs`, `credentialId`) are
 * written as `null`, never omitted, so the writer's shape stays stable across
 * phases.
 */
export interface AttemptRecordInput {
  requestLogId: string;
  attemptIndex: number;
  attemptOnTarget: number;
  isFallback: boolean;
  /** Public alias: `RouteTarget.modelName`. */
  provider: string;
  model: string;
  /** Upstream name sent / echoed back; `null` when nothing was served. */
  servedModel: string | null;
  /** Phase 2 (BYOK); always `null` in Phase 1. */
  credentialId?: string | null;
  status: AttemptStatus;
  isStream: boolean;
  providerStatus?: number | null;
  failureClass?: FailureClass | null;
  /** Wire code, e.g. `PROVIDER_TIMEOUT`; never the internal code. */
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Phase 3 (`Retry-After`); always `null` in Phase 1. */
  retryAfterMs?: number | null;
  latencyMs: number;
  upstreamLatencyMs?: number | null;
  overheadMs?: number | null;
  /** Phase 6 (streaming); always `null` in Phase 1. */
  timeToFirstTokenMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  pricingId?: string | null;
  inputCost?: Prisma.Decimal | null;
  outputCost?: Prisma.Decimal | null;
  totalCost?: Prisma.Decimal | null;
  /** Response id echoed by the provider. */
  providerRequestId?: string | null;
  createdAt: Date;
}

/** Single mapping from a raw observation to a persistable attempt row. */
export type AttemptRecordDraft = Omit<AttemptRecordInput, 'requestLogId'>;

/** The subset of `ProviderResponse` the attempt row needs. */
export interface AttemptObservationResult {
  response?: {
    id?: string;
    model?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  latencyMs: number;
}

/** What the failure classifier contributes to a failed attempt. */
export interface ClassifiedAttemptError {
  failureClass: FailureClass | null;
  /** Wire code as the client sees it. */
  wireCode: string | null;
  message: string | null;
  providerStatus?: number | null;
}

/**
 * The only path from an observation to an attempt row (§5.7).
 *
 * Latency numbers come from `deriveLatencySplit`, so `overheadMs` is present
 * exactly when `upstreamLatencyMs` is, and `RequestLogService.appendAttempt`
 * only ever persists what it is given.
 */
export function toAttemptRecord(
  observation: AttemptObservation<AttemptObservationResult>,
  classify: (error: unknown) => ClassifiedAttemptError,
): AttemptRecordDraft {
  const succeeded = observation.status === 'SUCCEEDED';
  const result = succeeded ? observation.result : undefined;
  const failure = succeeded ? null : classify(observation.error);
  const usage = result?.response?.usage;
  const split = deriveLatencySplit(observation);

  return {
    attemptIndex: observation.attemptIndex,
    attemptOnTarget: observation.attemptOnTarget,
    isFallback: observation.isFallback,
    provider: observation.target.provider,
    // Public alias, never the upstream id.
    model: observation.target.modelName,
    // Echoed model when there is a response, otherwise the name we sent.
    servedModel: result?.response?.model ?? observation.target.upstreamModel,
    credentialId: null,
    status: observation.status,
    // Caller intent lives on the parent row; Phase 1 never streams.
    isStream: false,
    providerStatus: failure?.providerStatus ?? null,
    failureClass: failure?.failureClass ?? null,
    errorCode: failure?.wireCode ?? null,
    errorMessage: failure?.message ?? null,
    retryAfterMs: null,
    latencyMs: observation.latencyMs,
    upstreamLatencyMs: split.upstreamLatencyMs,
    overheadMs: split.overheadMs,
    timeToFirstTokenMs: null,
    promptTokens: toTokenCount(usage?.prompt_tokens),
    completionTokens: toTokenCount(usage?.completion_tokens),
    totalTokens: toTokenCount(usage?.total_tokens),
    pricingId: null,
    inputCost: null,
    outputCost: null,
    totalCost: null,
    providerRequestId: result?.response?.id ?? null,
    // The attempt ends when it finishes; no separate clock read.
    createdAt: observation.finishedAt,
  };
}

/** `Int` column: drop NaN/Infinity rather than failing the whole insert. */
function toTokenCount(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.trunc(value);
}

export interface FinalizeSuccessInput {
  requestLogId: string;
  /** 200 in Phase 1. */
  statusCode: number;
  modelId: string | null;
  requestedModel: string;
  servedModel: string;
  provider: string;
  attemptCount: number;
  fallbackUsed: boolean;
  currency: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  pricingId: string | null;
  totalCost: Prisma.Decimal | null;
  latencyMs: number;
  finishedAt: Date;
}

export interface FinalizeFailureInput {
  requestLogId: string;
  statusCode: number;
  failureClass: FailureClass;
  /** Wire code as the client sees it. */
  errorCode: string;
  errorMessage: string | null;
  modelId?: string | null;
  provider?: string | null;
  servedModel?: string | null;
  attemptCount: number;
  fallbackUsed: boolean;
  latencyMs: number;
  finishedAt: Date;
}
