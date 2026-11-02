import { Injectable, Logger } from '@nestjs/common';
import type { AttemptObservation } from '../../common/observability/attempt-observation';
import { ProviderError } from './base.provider';
import { isRetryableProviderCode } from '../../common/errors/failure-classifier';
import { RouteTarget } from '../router/router.service';

export interface ResilienceOptions<T = unknown> {
  budgetMs?: number;
  /**
   * Observed for every resolved and every thrown attempt, synchronously.
   *
   * The consumer must not throw and must not await: the loop calls it merely to
   * report, so a slow or faulty observer cannot change routing (§6.3).
   */
  onAttempt?: (observation: AttemptObservation<T>) => void;
}

/**
 * Executes a routed request with:
 * - per-target timeouts (computed here so a client budget can clamp them)
 * - opt-in retries with bounded exponential backoff
 * - in-memory cooldown/circuit-breaker state that only opens when a target is
 *   abandoned, scaled by consecutive failures
 * - ordered fallback to configured secondary models
 * - an optional request-level deadline (budgetMs) so retries can never exceed
 *   the client's documented total timeout
 *
 * Chat completions are not idempotent. Retries are therefore opt-in through
 * Model.maxRetries and default to 0. Cooldowns are process-local by design for
 * this foundation; a shared store can replace the map in production.
 */
@Injectable()
export class ResilienceService {
  private readonly logger = new Logger(ResilienceService.name);
  private readonly cooldowns = new Map<string, number>();
  private readonly consecutiveFailures = new Map<string, number>();
  private readonly retryBaseDelayMs = 100;
  private readonly retryMaxDelayMs = 1000;

  async execute<T>(
    targets: RouteTarget[],
    operation: (target: RouteTarget, timeoutMs: number) => Promise<T>,
    options?: ResilienceOptions<T>,
  ): Promise<T> {
    if (targets.length === 0) {
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        'No provider routes are configured.',
      );
    }

    const budgetMs = options?.budgetMs;
    const startedAt = budgetMs !== undefined ? Date.now() : undefined;
    let lastError: unknown;
    let attemptIndex = 0;

    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      const key = this.targetKey(target);

      if (this.isCoolingDown(key)) {
        this.logger.warn(
          `Skipping ${target.provider}/${target.modelName}: cooldown is active`,
        );
        continue;
      }

      for (let attempt = 0; attempt <= target.maxRetries; attempt += 1) {
        let effectiveTimeoutMs = target.timeoutMs;

        if (budgetMs !== undefined && startedAt !== undefined) {
          const remainingMs = budgetMs - (Date.now() - startedAt);
          if (remainingMs <= 0) {
            // No attempt ran, so nothing is reported: `attemptCount` stays put.
            throw new ProviderError(
              'PROVIDER_TIMEOUT',
              'Request timeout budget exhausted',
            );
          }
          effectiveTimeoutMs = Math.min(target.timeoutMs, remainingMs);
        }

        const attemptStartedAt = new Date();

        try {
          const result = await operation(target, effectiveTimeoutMs);
          const finishedAt = new Date();

          // Reported before `recordSuccess` / `return`: a success is evidence
          // too, and `attemptIndex` counts it.
          this.reportAttempt(options, {
            attemptIndex,
            attemptOnTarget: attempt,
            isFallback: targetIndex > 0,
            target,
            status: 'SUCCEEDED',
            latencyMs: finishedAt.getTime() - attemptStartedAt.getTime(),
            result,
            startedAt: attemptStartedAt,
            finishedAt,
          });
          attemptIndex += 1;

          this.recordSuccess(key);
          return result;
        } catch (error) {
          const finishedAt = new Date();

          // Reported before the retry decision: retrying must never erase the
          // evidence that this attempt failed.
          this.reportAttempt(options, {
            attemptIndex,
            attemptOnTarget: attempt,
            isFallback: targetIndex > 0,
            target,
            status: 'FAILED',
            latencyMs: finishedAt.getTime() - attemptStartedAt.getTime(),
            error,
            startedAt: attemptStartedAt,
            finishedAt,
          });
          attemptIndex += 1;

          lastError = error;

          if (!(error instanceof ProviderError)) {
            throw error;
          }

          // A provider-side validation failure will not improve by retrying or
          // by silently switching to a different model.
          if (error.code === 'PROVIDER_BAD_REQUEST') {
            throw error;
          }

          const retryable = isRetryableProviderCode(error.code);
          const hasAnotherAttempt = attempt < target.maxRetries;

          // Retrying the same target immediately: leave cooldown state alone so
          // other requests do not skip a target while its retry is pending.
          if (retryable && hasAnotherAttempt) {
            await this.sleep(
              Math.min(
                this.retryMaxDelayMs,
                this.retryBaseDelayMs * 2 ** attempt,
              ),
            );
            continue;
          }

          if (retryable) {
            // The target is being abandoned: open a cooldown scaled by how
            // many consecutive failures this target has seen.
            this.openCooldownAfterFailure(key, target);
          }

          break;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'All provider routes are temporarily unavailable.',
    );
  }

  private targetKey(target: RouteTarget): string {
    return `${target.provider}:${target.modelId}:${target.modelName}`;
  }

  /**
   * Delivers one observation to the consumer without letting it affect routing.
   *
   * `onAttempt` is expected to be synchronous and non-throwing, but this is the
   * boundary that makes that expectation non-binding: a consumer bug is logged
   * and ignored, never propagated into the retry loop (§6.3).
   */
  private reportAttempt<T>(
    options: ResilienceOptions<T> | undefined,
    observation: AttemptObservation<T>,
  ): void {
    const onAttempt = options?.onAttempt;

    if (!onAttempt) {
      return;
    }

    try {
      onAttempt(observation);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown error';
      this.logger.warn(`Attempt observer threw (${name}); observation ignored`);
    }
  }

  private recordSuccess(key: string): void {
    this.cooldowns.delete(key);
    this.consecutiveFailures.set(key, 0);
  }

  private openCooldownAfterFailure(key: string, target: RouteTarget): void {
    const failures = (this.consecutiveFailures.get(key) ?? 0) + 1;
    this.consecutiveFailures.set(key, failures);

    const durationMs = Math.min(
      target.cooldownMs,
      1000 * 2 ** (failures - 1),
    );

    if (durationMs > 0) {
      this.cooldowns.set(key, Date.now() + durationMs);
    }
  }

  private isCoolingDown(key: string): boolean {
    const until = this.cooldowns.get(key);
    if (!until) {
      return false;
    }

    if (until <= Date.now()) {
      this.cooldowns.delete(key);
      return false;
    }

    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
