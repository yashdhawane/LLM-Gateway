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

  private readonly logger = new Logger(RequestLogService.name);

  /** Handle kept so a test (or shutdown) can stop the sweep (§6.7). */
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telemetry: TelemetryService,
  ) {}

  /**
   * Fire-and-forget sweep on boot, then every 5 minutes (§6.7).
   *
   * `void` because the sweep is total: it reports its own failure to telemetry
   * and resolves, so nothing can reject here. `unref()` keeps the timer from
   * holding the process alive.
   */
  onModuleInit(): void {
    void this.sweepStaleProcessing();

    this.sweepTimer = setInterval(() => {
      void this.sweepStaleProcessing();
    }, RequestLogService.SWEEP_INTERVAL_MS);

    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Marks PROCESSING rows older than `olderThanMs` as `FAILED`/`ABANDONED`.
   *
   * Raw SQL, not `updateMany`: `latencyMs = now() - startedAt` references
   * another column, which Prisma's `data` cannot express (§6.7).
   *
   * The `NOT EXISTS` guard is load-bearing (S3): a row that produced an attempt
   * inside the window is provably still executing and must never be abandoned.
   * Only `PROCESSING` rows are touched, so a finalized row is never rewritten.
   *
   * Returns the affected row count; never throws.
   */
  async sweepStaleProcessing(
    olderThanMs: number = RequestLogService.STALE_PROCESSING_MS,
  ): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - olderThanMs);

      // `Prisma.sql` with `${cutoff}` is a bound parameter - never interpolated.
      const affected = await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "RequestLog" rl
           SET "status" = 'FAILED',
               "errorCode" = 'ABANDONED',
               "failureClass" = 'TIMEOUT',
               "finishedAt" = now(),
               "latencyMs" = GREATEST(0, (EXTRACT(EPOCH FROM (now() - rl."startedAt")) * 1000)::int)
         WHERE rl."status" = 'PROCESSING'
           AND rl."startedAt" < ${cutoff}
           AND NOT EXISTS (
             SELECT 1 FROM "RequestAttempt" ra
              WHERE ra."requestLogId" = rl."id"
                AND ra."createdAt" > ${cutoff}
           )
      `);

      return affected;
    } catch (error) {
      // No response exists for a sweep: `0` is the documented "none" (§6.8).
      this.reportFailure('sweep', 0, error);
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
      this.reportFailure(input.requestLogId, 0, error);
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
      this.reportFailure(input.requestLogId, input.statusCode, error);
      return false;
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
      this.reportFailure(input.requestLogId, input.statusCode, error);
      return false;
    }
  }

  /**
   * The single reporting path (§6.8 / S1).
   *
   * `traceId` is the request-log id here: it is the correlation key these
   * methods actually hold, and it joins straight to `RequestLog.traceId`.
   */
  private reportFailure(
    traceId: string,
    statusCode: number,
    error: unknown,
  ): void {
    this.telemetry.logError({
      traceId,
      errorCode: 'REQUEST_LOG_WRITE_FAILED',
      errorMessage: sanitizeErrorMessage(error) ?? 'unknown',
      statusCode,
    });
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
