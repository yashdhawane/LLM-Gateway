import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { sanitizeErrorMessage } from '../../common/errors/failure-classifier';
import { PrismaService } from '../../prisma/prisma.service';
import { TelemetryService } from '../telemetry/telemetry.module';
import type {
  AttemptRecordInput,
  FinalizeFailureInput,
  FinalizeSuccessInput,
  StartRequestLogInput,
} from './request-log.types';

/**
 * The only writer of `RequestLog` / `RequestAttempt`.
 *
 * Write-early, update-late: the PROCESSING row exists before routing (§6.1),
 * attempts are appended as they happen (§6.2) and finalization is a guarded
 * `updateMany`, so exactly one caller can close a row.
 *
 * TOTAL BY CONTRACT (§6.8): every method catches its own error, reports
 * `REQUEST_LOG_WRITE_FAILED` to telemetry and returns `null` / `void` /
 * `false`. A logging failure must never change the caller's response.
 */
@Injectable()
export class RequestLogService implements OnModuleInit, OnModuleDestroy {
  static readonly STALE_PROCESSING_MS = 15 * 60 * 1000;
  static readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000;

  /**
   * How often this instance refreshes `heartbeatAt` for the requests it owns.
   *
   * Several beats must fit inside the stale cutoff so a single slow write (or
   * one missed timer tick) never makes a live request look abandoned.
   */
  static readonly HEARTBEAT_INTERVAL_MS = 30 * 1000;

  private readonly logger = new Logger(RequestLogService.name);

  /** Handle kept so a test (or shutdown) can stop the sweep (§6.7). */
  private sweepTimer?: ReturnType<typeof setInterval>;

  /** Handle for the durable-heartbeat timer. */
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  /**
   * Request-log ids this process started and has not finalized.
   *
   * This is an in-memory registry for batching heartbeats, plus a fast-path
   * exclusion for this process's own sweep. It is *not* the distributed
   * correctness boundary: another instance cannot see it. Cross-instance
   * liveness comes from `RequestLog.heartbeatAt`, which is shared through
   * PostgreSQL and compared against the database clock.
   */
  private readonly inFlightRequestLogIds = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly telemetry: TelemetryService,
  ) {}

  /**
   * Fire-and-forget sweep on boot, then every 5 minutes (§6.7); durable
   * heartbeats every 30 seconds.
   *
   * `void` because both operations are total: they report their own failure to
   * telemetry and resolve, so nothing can reject here. `unref()` keeps the
   * timers from holding the process alive.
   */
  onModuleInit(): void {
    // `catch` is belt and braces on top of the service's own totality: no
    // fire-and-forget call may ever surface as an unhandled rejection.
    void this.sweepStaleProcessing().catch(() => {});

    this.sweepTimer = setInterval(() => {
      void this.sweepStaleProcessing().catch(() => {});
    }, RequestLogService.SWEEP_INTERVAL_MS);

    this.sweepTimer.unref();

    // Keeps this instance's in-flight rows alive for every other instance's
    // sweep. `unref()` for the same reason as the sweep timer.
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatInFlight().catch(() => {});
    }, RequestLogService.HEARTBEAT_INTERVAL_MS);

    this.heartbeatTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }

    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Marks PROCESSING rows whose durable heartbeat expired as `FAILED`/`ABANDONED`.
   *
   * Raw SQL, not `updateMany`: `latencyMs = now() - startedAt` references
   * another column, which Prisma's `data` cannot express (§6.7).
   *
   * The cutoff is computed by PostgreSQL (`now()`), never by the application
   * clock: instances can have skewed clocks, and the timestamp they are
   * comparing was written by whichever instance owns the request. The bound
   * value is only the interval length.
   *
   * `heartbeatAt` is the distributed liveness proof: every instance refreshes
   * it for the requests it owns, so a live request on another instance is never
   * abandoned. A crashed instance stops refreshing it and becomes eligible
   * after the cutoff. The `NOT EXISTS` guard is extra evidence of progress
   * between heartbeats. Only `PROCESSING` rows are touched, so a finalized row
   * is never rewritten.
   *
   * The local ownership guard is a fast path for this process only; it is not
   * what protects requests owned by another instance.
   *
   * Returns the affected row count; never throws.
   */
  async sweepStaleProcessing(
    olderThanMs: number = RequestLogService.STALE_PROCESSING_MS,
  ): Promise<number> {
    try {
      const staleMs = Math.max(0, Math.trunc(olderThanMs));
      const ownedIds = [...this.inFlightRequestLogIds];
      const ownershipGuard =
        ownedIds.length === 0
          ? Prisma.empty
          : Prisma.sql`AND rl."id" NOT IN (${Prisma.join(ownedIds)})`;

      // Every time cutoff is `now()` in the database. Only the interval is
      // bound, so no application `Date` can leak into the comparison.
      const affected = await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "RequestLog" rl
           SET "status" = 'FAILED',
               "errorCode" = 'ABANDONED',
               "failureClass" = 'ABANDONED',
               "finishedAt" = now(),
               "latencyMs" = GREATEST(0, (EXTRACT(EPOCH FROM (now() - rl."startedAt")) * 1000)::int)
         WHERE rl."status" = 'PROCESSING'
           AND rl."heartbeatAt" < now() - (${staleMs}::int * interval '1 millisecond')
           AND NOT EXISTS (
             SELECT 1 FROM "RequestAttempt" ra
              WHERE ra."requestLogId" = rl."id"
                AND ra."createdAt" > now() - (${staleMs}::int * interval '1 millisecond')
           )
           ${ownershipGuard}
      `);

      return affected;
    } catch (error) {
      // No response exists for a sweep: `0` is the documented "none" (§6.8).
      this.reportFailure('sweep', 0, error);
      return 0;
    }
  }

  /**
   * Refreshes `heartbeatAt` for every request this instance still owns.
   *
   * One statement for the whole batch, on the database clock, guarded by
   * `status = 'PROCESSING'`: a row another instance already abandoned is never
   * resurrected. TOTAL like every other write: a failure is reported to
   * telemetry and returns `0`.
   */
  async heartbeatInFlight(): Promise<number> {
    const ids = [...this.inFlightRequestLogIds];

    if (ids.length === 0) {
      return 0;
    }

    try {
      return await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "RequestLog"
           SET "heartbeatAt" = now()
         WHERE "status" = 'PROCESSING'
           AND "id" IN (${Prisma.join(ids)})
      `);
    } catch (error) {
      this.reportFailure('heartbeat', 0, error);
      return 0;
    }
  }

  /** Returns `null` (never throws) when the row cannot be written. */
  async start(input: StartRequestLogInput): Promise<{ id: string } | null> {
    try {
      const created = await this.prisma.requestLog.create({
        data: {
          traceId: input.traceId,
          requestId: input.requestId,
          userId: input.userId,
          apiKeyId: input.apiKeyId,
          requestedModel: input.requestedModel,
          isStream: input.isStream === true,
          startedAt: input.startedAt,
          // Unknown before routing; the late update fills them in.
          status: 'PROCESSING',
          statusCode: 0,
        },
        select: { id: true },
      });

      this.inFlightRequestLogIds.add(created.id);

      return { id: created.id };
    } catch (error) {
      this.reportFailure(input.traceId, 0, error);
      return null;
    }
  }

  /**
   * Never throws. Swallows + reports.
   *
   * `upstreamLatencyMs` and `overheadMs` are persisted **verbatim**: the split
   * is computed once, in `deriveLatencySplit`, and never recomputed here.
   */
  async appendAttempt(input: AttemptRecordInput): Promise<void> {
    try {
      await this.prisma.requestAttempt.create({
        data: {
          requestLogId: input.requestLogId,
          attemptIndex: input.attemptIndex,
          attemptOnTarget: input.attemptOnTarget,
          isFallback: input.isFallback,
          provider: input.provider,
          model: input.model,
          servedModel: input.servedModel,
          // Reserved for Phase 2 (BYOK): written, never omitted.
          credentialId: input.credentialId ?? null,
          status: input.status,
          isStream: input.isStream === true,
          providerStatus: input.providerStatus ?? null,
          failureClass: input.failureClass ?? null,
          errorCode: input.errorCode ?? null,
          errorMessage: sanitizeErrorMessage(input.errorMessage),
          // Reserved for Phase 3 (`Retry-After`).
          retryAfterMs: input.retryAfterMs ?? null,
          latencyMs: input.latencyMs,
          upstreamLatencyMs: input.upstreamLatencyMs ?? null,
          overheadMs: input.overheadMs ?? null,
          // Reserved for Phase 6 (streaming).
          timeToFirstTokenMs: input.timeToFirstTokenMs ?? null,
          promptTokens: input.promptTokens ?? null,
          completionTokens: input.completionTokens ?? null,
          totalTokens: input.totalTokens ?? null,
          pricingId: input.pricingId ?? null,
          inputCost: input.inputCost ?? null,
          outputCost: input.outputCost ?? null,
          totalCost: input.totalCost ?? null,
          providerRequestId: input.providerRequestId ?? null,
          createdAt: input.createdAt,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        // `@@unique([requestLogId, attemptIndex])` already holds this attempt:
        // a replay, not a fault. The first write is authoritative.
        this.logger.debug(
          `Attempt ${input.attemptIndex} for request log ${input.requestLogId} already recorded`,
        );
        return;
      }

      // No response status exists at attempt time: 0 is the documented "none".
      this.reportFailure(input.traceId ?? input.requestLogId, 0, error);
    }
  }

  /** Guarded by status = PROCESSING; true only when this call finalized the row. */
  async finalizeSuccess(input: FinalizeSuccessInput): Promise<boolean> {
    try {
      const result = await this.prisma.requestLog.updateMany({
        where: { id: input.requestLogId, status: 'PROCESSING' },
        data: {
          status: 'SUCCESS',
          statusCode: input.statusCode,
          modelId: input.modelId,
          requestedModel: input.requestedModel,
          servedModel: input.servedModel,
          provider: input.provider,
          attemptCount: input.attemptCount,
          fallbackUsed: input.fallbackUsed,
          currency: input.currency,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          totalTokens: input.totalTokens,
          pricingId: input.pricingId,
          totalCost: input.totalCost,
          latencyMs: input.latencyMs,
          finishedAt: input.finishedAt,
          // A success has no failure evidence; clear anything a retry set.
          failureClass: null,
          errorCode: null,
          errorMessage: null,
        },
      });

      return result.count === 1;
    } catch (error) {
      this.reportFailure(
        input.traceId ?? input.requestLogId,
        input.statusCode,
        error,
      );
      return false;
    } finally {
      // The handler is done whether the guarded write won or lost: release
      // ownership so a later sweep can reclaim the row if it is still open.
      this.inFlightRequestLogIds.delete(input.requestLogId);
    }
  }

  /** Guarded by status = PROCESSING; true only when this call finalized the row. */
  async finalizeFailure(input: FinalizeFailureInput): Promise<boolean> {
    try {
      const result = await this.prisma.requestLog.updateMany({
        where: { id: input.requestLogId, status: 'PROCESSING' },
        data: {
          status: 'FAILED',
          statusCode: input.statusCode,
          // The last failure of the request, not the first.
          failureClass: input.failureClass,
          errorCode: input.errorCode,
          errorMessage: sanitizeErrorMessage(input.errorMessage),
          modelId: input.modelId ?? null,
          provider: input.provider ?? null,
          servedModel: input.servedModel ?? null,
          attemptCount: input.attemptCount,
          fallbackUsed: input.fallbackUsed,
          latencyMs: input.latencyMs,
          finishedAt: input.finishedAt,
        },
      });

      return result.count === 1;
    } catch (error) {
      this.reportFailure(
        input.traceId ?? input.requestLogId,
        input.statusCode,
        error,
      );
      return false;
    } finally {
      this.inFlightRequestLogIds.delete(input.requestLogId);
    }
  }

  /**
   * The single reporting path (§6.8 / S1).
   *
   * `traceId` is the caller's request trace when it is known, so a write
   * failure joins to `RequestLog.traceId`; the request-log id is the fallback
   * these methods always hold. TOTAL: a telemetry sink that throws is logged
   * and swallowed, because a sweep (or a response path) must not reject.
   */
  private reportFailure(
    traceId: string,
    statusCode: number,
    error: unknown,
  ): void {
    const errorMessage = sanitizeErrorMessage(error) ?? 'unknown';

    try {
      this.telemetry.logError({
        traceId,
        errorCode: 'REQUEST_LOG_WRITE_FAILED',
        errorMessage,
        statusCode,
      });
    } catch (telemetryError) {
      // The reporter is the last line: never recurse, only log.
      this.logger.error(
        `[${traceId}] telemetry.logError failed: ${
          sanitizeErrorMessage(telemetryError) ?? 'unknown'
        } (original: ${errorMessage})`,
      );
    }
  }
}

/**
 * `P2002` is Prisma's unique-constraint violation. Duck-typed so a test fake
 * (and a driver-level error) is recognised without an `instanceof` check that
 * only the real client would satisfy.
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
