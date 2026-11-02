import { Injectable, Logger } from '@nestjs/common';
import type { RequestContext } from '../../common/context/request-context';
import {
  classifyException,
  sanitizeErrorMessage,
} from '../../common/errors/failure-classifier';
import type { AttemptObservation } from '../../common/observability/attempt-observation';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../router/schemas/chat-completion.schema';
import { RouterService, RouteTarget } from '../router/router.service';
import { CredentialManager } from '../providers/credential.manager';
import { ProviderService } from '../providers/provider.service';
import { ResilienceService } from '../providers/resilience.service';
import { ProviderResponse } from '../providers/base.provider';
import { TelemetryService } from '../telemetry/telemetry.module';
import { CostCalculator, type CostBreakdown } from '../pricing/cost-calculator';
import { RequestLogService } from '../logging/request-log.service';
import {
  toAttemptRecord,
  type ClassifiedAttemptError,
} from '../logging/request-log.types';

/**
 * The classifier contribution to a failed attempt row (§6.2/§6.5).
 *
 * `wireCode` and `failureClass` come from the shared taxonomy, so an attempt
 * row and the client-visible error never disagree. The message is the
 * sanitized underlying error - never the fixed client-facing string, which
 * carries no diagnostic detail.
 */
function classifyAttemptError(error: unknown): ClassifiedAttemptError {
  const classified = classifyException(error);

  return {
    failureClass: classified.failureClass,
    wireCode: classified.wireCode,
    message: sanitizeErrorMessage(error),
    providerStatus: classified.providerStatus ?? null,
  };
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly router: RouterService,
    private readonly providers: ProviderService,
    private readonly requestLogs: RequestLogService,
    private readonly telemetry: TelemetryService,
    private readonly credentials: CredentialManager,
    private readonly resilience: ResilienceService,
    private readonly costCalculator: CostCalculator,
  ) {}

  async createCompletion(
    request: ChatCompletionRequest,
    context: RequestContext,
  ): Promise<ChatCompletionResponse> {
    // Write-early: the PROCESSING row exists before the first query that can
    // hang, so even a routing failure leaves evidence (§6.1).
    let logId: string | null = null;

    try {
      const started = await this.requestLogs.start({
        traceId: context.traceId,
        requestId: context.requestId,
        userId: context.userId,
        apiKeyId: context.apiKeyId,
        requestedModel: context.requestedModel,
        isStream: context.isStream,
        startedAt: context.startedAt,
      });
      logId = started?.id ?? null;
    } catch (error) {
      this.reportLoggingFailure('request-log.start', error, context.traceId);
    }

    const routing = await this.router.resolveRoute(request.model);
    const { timeout, ...providerRequest } = request;

    // Attempt writes are started, never awaited inline: a hung request must
    // leave the attempts that already happened on disk (§6.2).
    const pendingWrites: Promise<void>[] = [];
    let attemptCount = 0;
    let fallbackUsed = false;

    const onAttempt = (
      observation: AttemptObservation<{
        target: RouteTarget;
        response: ProviderResponse;
      }>,
    ) => {
      attemptCount += 1;
      fallbackUsed = fallbackUsed || observation.isFallback;

      const parentId = logId;

      if (parentId === null) {
        // No parent row: an orphan attempt is worse than nothing (§6.2).
        return;
      }

      pendingWrites.push(
        (async () => {
          const draft = this.toDraft(observation, context.traceId);

          if (draft === null) {
            return;
          }

          const cost = await this.calculateCost(
            {
              provider: observation.target.provider,
              model: observation.target.upstreamModel,
              userId: context.userId,
              at: context.startedAt,
              promptTokens: draft.promptTokens ?? null,
              completionTokens: draft.completionTokens ?? null,
            },
            context.traceId,
          );

          try {
            await this.requestLogs.appendAttempt({
              ...draft,
              ...(cost ?? {}),
              requestLogId: parentId,
            });
          } catch (error) {
            this.reportLoggingFailure(
              'request-log.appendAttempt',
              error,
              context.traceId,
            );
          }
        })(),
      );
    };

    try {
      const result = await this.resilience.execute(
        routing.targets,
        (target, timeoutMs) =>
          this.callProvider(target, providerRequest, timeoutMs, context),
        {
          ...(timeout !== undefined ? { budgetMs: timeout } : {}),
          onAttempt,
        },
      );

      // Attempt rows land before the parent leaves PROCESSING (§6.2).
      await Promise.allSettled(pendingWrites);

      const usage = result.response.response.usage;
      const promptTokens = usage?.prompt_tokens ?? null;
      const completionTokens = usage?.completion_tokens ?? null;
      const totalTokens = usage?.total_tokens ?? null;

      const cost = await this.calculateCost(
        {
          provider: result.target.provider,
          model: result.target.upstreamModel,
          userId: context.userId,
          at: context.startedAt,
          promptTokens,
          completionTokens,
        },
        context.traceId,
      );

      if (logId !== null) {
        try {
          await this.requestLogs.finalizeSuccess({
            requestLogId: logId,
            statusCode: 200,
            modelId: result.target.modelId,
            requestedModel: context.requestedModel,
            servedModel:
              result.response.response.model ?? result.target.upstreamModel,
            provider: result.target.provider,
            attemptCount,
            fallbackUsed,
            currency: cost?.currency ?? null,
            promptTokens,
            completionTokens,
            totalTokens,
            pricingId: cost?.pricingId ?? null,
            totalCost: cost?.totalCost ?? null,
            latencyMs: this.elapsedMs(context),
            finishedAt: new Date(),
          });
        } catch (error) {
          this.reportLoggingFailure(
            'request-log.finalizeSuccess',
            error,
            context.traceId,
          );
        }
      }

      this.telemetry.logRequest({
        traceId: context.traceId,
        userId: context.userId,
        apiKeyId: context.apiKeyId ?? undefined,
        modelId: result.target.modelId,
        provider: result.target.provider,
        statusCode: 200,
        latencyMs: result.response.latencyMs,
        promptTokens: promptTokens ?? undefined,
        completionTokens: completionTokens ?? undefined,
        totalTokens: totalTokens ?? undefined,
      });

      return {
        ...result.response.response,
        trace_id: context.traceId,
      };
    } catch (error) {
      const classified = classifyException(error);

      await Promise.allSettled(pendingWrites);

      if (logId !== null) {
        try {
          await this.requestLogs.finalizeFailure({
            requestLogId: logId,
            statusCode: classified.httpStatus,
            failureClass: classified.failureClass,
            errorCode: classified.wireCode,
            errorMessage: sanitizeErrorMessage(error),
            attemptCount,
            fallbackUsed,
            latencyMs: this.elapsedMs(context),
            finishedAt: new Date(),
          });
        } catch (finalizeError) {
          this.reportLoggingFailure(
            'request-log.finalizeFailure',
            finalizeError,
            context.traceId,
          );
        }
      }

      this.telemetry.logError({
        traceId: context.traceId,
        errorCode: classified.wireCode,
        errorMessage: sanitizeErrorMessage(error) ?? 'unknown',
        statusCode: classified.httpStatus,
      });

      // The original error, untouched: the controller still owns the mapping.
      throw error;
    }
  }

  private async callProvider(
    target: RouteTarget,
    request: Omit<ChatCompletionRequest, 'timeout'>,
    timeoutMs: number,
    context: RequestContext,
  ): Promise<{ target: RouteTarget; response: ProviderResponse }> {
    const credential = this.credentials.resolve(
      target.provider,
      target.baseUrl,
    );

    return {
      target,
      response: await this.providers.chatCompletion(
        target.provider,
        { ...request, model: target.upstreamModel },
        {
          baseUrl: credential.baseUrl,
          apiKey: credential.apiKey,
          timeoutMs,
        },
        context.traceId,
      ),
    };
  }

  /**
   * The single mapping from an observation to an attempt draft (§5.7).
   *
   * Returns `null` when the mapping itself fails: the draft is the only input
   * `appendAttempt` accepts, so there is nothing safe to write without it.
   */
  private toDraft(
    observation: AttemptObservation<{
      target: RouteTarget;
      response: ProviderResponse;
    }>,
    traceId: string,
  ) {
    try {
      // The loop reports `{ target, response }` so the success path knows which
      // target served; `toAttemptRecord` only needs the provider response.
      return toAttemptRecord(
        { ...observation, result: observation.result?.response },
        classifyAttemptError,
      );
    } catch (error) {
      this.reportLoggingFailure('request-log.toAttemptRecord', error, traceId);
      return null;
    }
  }

  /** `CostCalculator.calculate` is total; this covers a fake or a subclass. */
  private async calculateCost(
    input: {
      provider: string;
      model: string;
      userId: string;
      at: Date;
      promptTokens: number | null;
      completionTokens: number | null;
    },
    traceId: string,
  ): Promise<CostBreakdown | null> {
    try {
      return await this.costCalculator.calculate(input);
    } catch (error) {
      this.reportLoggingFailure('cost.calculate', error, traceId);
      return null;
    }
  }

  private elapsedMs(context: RequestContext): number {
    return Math.max(0, Date.now() - context.startedAt.getTime());
  }

  /**
   * The single wrapper around every logging and pricing call (§S1/§6.8).
   *
   * Emits `REQUEST_LOG_WRITE_FAILED` through telemetry and a `Logger.error`
   * line carrying the trace ID, so the failure is observable from both sides.
   * Never throws: the provider response must reach the caller regardless.
   */
  private reportLoggingFailure(
    scope: string,
    error: unknown,
    traceId: string,
  ): void {
    const errorMessage = `${scope}: ${sanitizeErrorMessage(error) ?? 'unknown'}`;

    this.telemetry.logError({
      traceId,
      errorCode: 'REQUEST_LOG_WRITE_FAILED',
      errorMessage,
      statusCode: 0,
    });

    this.logger.error(`[${traceId}] ${errorMessage}`);
  }
}
