import type { RouteTarget } from '../../modules/router/router.service';

/**
 * What `ResilienceService` reports for a single provider attempt (§6.3).
 *
 * Deliberately framework-free and *not* in `src/modules/logging/`:
 * `providers/resilience.service.ts` emits this type, and `providers/` must
 * never import the logging module.
 */
export interface AttemptObservation<T> {
  /** 0-based across the whole request (all targets and retries). */
  attemptIndex: number;
  /** 0-based within this target: the retry index. */
  attemptOnTarget: number;
  isFallback: boolean;
  target: RouteTarget;
  status: 'SUCCEEDED' | 'FAILED';
  /** Wall time of this attempt, measured by the resilience loop. */
  latencyMs: number;
  /** Present iff `status === 'SUCCEEDED'`. */
  result?: T;
  /** Present iff `status === 'FAILED'`. */
  error?: unknown;
  startedAt: Date;
  finishedAt: Date;
}

/** The only two timing columns persisted on `RequestAttempt`. */
export interface LatencySplit {
  upstreamLatencyMs: number | null;
  overheadMs: number | null;
}

/**
 * The ONLY place the latency split is computed (§5.6).
 *
 * - `upstreamLatencyMs` is `ProviderResponse.latencyMs`, measured inside the
 *   adapter; it is `null` whenever there is no provider response.
 * - `overheadMs` is `latencyMs - upstreamLatencyMs`, clamped at 0 so clock
 *   skew can never persist a negative value. It exists whenever
 *   `upstreamLatencyMs` exists, so the pair is never half-filled.
 * - Failed attempts have no provider timing: both stay `null` rather than
 *   inventing a number.
 */
export function deriveLatencySplit(
  observation: AttemptObservation<unknown>,
): LatencySplit {
  const upstreamLatencyMs = readUpstreamLatency(observation.result);

  if (upstreamLatencyMs === null) {
    return { upstreamLatencyMs: null, overheadMs: null };
  }

  return {
    upstreamLatencyMs,
    overheadMs: Math.max(0, observation.latencyMs - upstreamLatencyMs),
  };
}

/**
 * Reads `result.latencyMs` without trusting the generic payload: a missing,
 * non-numeric or non-finite value means "no provider timing" and therefore
 * `null` (never `NaN`, which an `Int` column cannot store).
 */
function readUpstreamLatency(result: unknown): number | null {
  if (result === null || typeof result !== 'object') {
    return null;
  }

  const latencyMs = (result as { latencyMs?: unknown }).latencyMs;

  return typeof latencyMs === 'number' && Number.isFinite(latencyMs)
    ? latencyMs
    : null;
}
