import { Injectable, Logger } from '@nestjs/common';
import type { RequestContext } from '../../common/context/request-context';
import {
  classifyException,
  classifyProviderError,
  sanitizeErrorMessage,
  type ClassifiedError,
} from '../../common/errors/failure-classifier';
import {
  ERROR_DEFINITIONS,
  errorTypeForStatus,
  type FailureClass,
  type GatewayErrorCode,
} from '../../common/errors/error-taxonomy';
import type { AttemptObservation } from '../../common/observability/attempt-observation';
import type { StreamSink } from '../../common/sse/stream-sink';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../router/schemas/chat-completion.schema';
import { RouterService, RouteTarget } from '../router/router.service';
import { CredentialManager } from '../providers/credential.manager';
import { ProviderService } from '../providers/provider.service';
import { ResilienceService } from '../providers/resilience.service';
import {
  ChatCompletionChunk,
  ProviderError,
  ProviderResponse,
} from '../providers/base.provider';
import { TelemetryService } from '../telemetry/telemetry.module';
import { CostCalculator, type CostBreakdown } from '../pricing/cost-calculator';
import { RequestLogService } from '../logging/request-log.service';
import {
  toAttemptRecord,
  type AttemptMappingOptions,
  type AttemptObservationResult,
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

/** What one streaming attempt returns once its iterable is exhausted. */
interface StreamOutcome {
  target: RouteTarget;
  response: {
    id: string;
    model: string;
    usage?: ChatCompletionChunk['usage'];
  };
  latencyMs: number;
  timeToFirstTokenMs: number | null;
}

/**
 * A failure that happened after the 200 was committed to the client.
 *
 * Deliberately not a `ProviderError`: the resilience loop retries and falls
 * back for provider errors, and a second provider would restart an answer the
 * client is already reading. Anything that is not a provider error is rethrown
 * immediately, which is exactly the behaviour a committed stream needs.
 */
class StreamCommittedError extends Error {
  readonly name = 'StreamCommittedError';

  constructor(
    message: string,
    readonly classified: ClassifiedError,
  ) {
    super(message);
  }
}

/** The observation shape an attempt draft needs, for both paths. */
type AttemptResult = AttemptObservationResult & {
  timeToFirstTokenMs?: number | null;
};

function classifiedFromDefinition(code: GatewayErrorCode): ClassifiedError {
  const definition = ERROR_DEFINITIONS[code];

  return {
    errorCode: code,
    wireCode: definition.wireCode,
    failureClass: definition.failureClass,
    httpStatus: definition.httpStatus,
    message: definition.message,
    retryable: false,
    isProviderError: false,
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

    const { timeout, ...providerRequest } = request;

    // Attempt writes are started, never awaited inline: a hung request must
    // leave the attempts that already happened on disk (§6.2).
    const pendingWrites: Promise<void>[] = [];
    let attemptCount = 0;
    let fallbackUsed = false;
    // The last observation decides the parent row's provider attribution: a
    // failed request must still answer "through which provider?" (§1 Q1).
    // A holder object, not a bare `let`: the write happens inside `onAttempt`
    // and the read in `catch`, where TypeScript would otherwise narrow a
    // `let` back to its `null` initializer.
    const observed = {
      last: null as AttemptObservation<{
        target: RouteTarget;
        response: ProviderResponse;
      }> | null,
    };

    const onAttempt = (
      observation: AttemptObservation<{
        target: RouteTarget;
        response: ProviderResponse;
      }>,
    ) => {
      // Recorded before the cheap guards below: attribution must survive a
      // missing parent row or a failed attempt write.
      observed.last = observation;
      attemptCount += 1;
      fallbackUsed = fallbackUsed || observation.isFallback;

      this.recordAttempt(
        { ...observation, result: observation.result?.response },
        context,
        logId,
        {},
        pendingWrites,
      );
    };

    try {
      // Routing is the first query that can fail or hang (§6.1): it belongs
      // inside the guard so `MODEL_NOT_FOUND` finalizes the PROCESSING row as
      // a caller fault instead of leaving it for the stale sweep.
      const routing = await this.router.resolveRoute(request.model);

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
            traceId: context.traceId,
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

      // A telemetry listener is outside our control: it must never turn a paid
      // 200 into a 500 (S1/§6.8), only a log line.
      try {
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
      } catch (telemetryError) {
        this.reportTelemetryFailure('telemetry.logRequest', telemetryError, context.traceId);
      }

      return {
        ...result.response.response,
        trace_id: context.traceId,
      };
    } catch (error) {
      // Classifying must never skip the attempt writes below or replace the
      // original error: a throwing `getResponse()` degrades to the same
      // INTERNAL default `classifyException` produces for an unknown error.
      let classification: Pick<
        ClassifiedError,
        'httpStatus' | 'failureClass' | 'wireCode'
      >;

      try {
        classification = classifyException(error);
      } catch {
        classification = {
          httpStatus: 500,
          failureClass: 'INTERNAL',
          wireCode: 'INTERNAL_ERROR',
        };
      }

      await Promise.allSettled(pendingWrites);

      if (logId !== null) {
        try {
          await this.requestLogs.finalizeFailure({
            requestLogId: logId,
            traceId: context.traceId,
            statusCode: classification.httpStatus,
            failureClass: classification.failureClass,
            errorCode: classification.wireCode,
            errorMessage: sanitizeErrorMessage(error),
            // The last attempt decides attribution; a failure still names the
            // provider and model it went through, but only a SUCCEEDED
            // observation may claim a served model.
            modelId: observed.last?.target.modelId ?? null,
            provider: observed.last?.target.provider ?? null,
            servedModel:
              observed.last?.status === 'SUCCEEDED'
                ? (observed.last.result?.response?.response?.model ??
                  observed.last.target.upstreamModel)
                : null,
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

      // Guarded for the same reason as the success path: the original error is
      // the one the controller must see, telemetry throw or not.
      try {
        this.telemetry.logError({
          traceId: context.traceId,
          errorCode: classification.wireCode,
          errorMessage: sanitizeErrorMessage(error) ?? 'unknown',
          statusCode: classification.httpStatus,
        });
      } catch (telemetryError) {
        this.reportTelemetryFailure('telemetry.logError', telemetryError, context.traceId);
      }

      // The original error, untouched: the controller still owns the mapping.
      throw error;
    }
  }

  /**
   * Streams a completion into an already constructed sink.
   *
   * The contract that differs from `createCompletion` is where the response is
   * committed: nothing is written until the first chunk arrives, so a routing
   * or provider failure before that point can still be a normal JSON error and
   * can still retry or fall back. Once a byte is out, the status is 200 forever;
   * a later failure is an SSE error frame and is never retried, because a
   * second provider would restart an answer the user is already reading.
   */
  async streamCompletion(
    request: ChatCompletionRequest,
    context: RequestContext,
    sink: StreamSink,
  ): Promise<void> {
    // Write-early, exactly like the blocking path (§6.1).
    let logId: string | null = null;

    try {
      const started = await this.requestLogs.start({
        traceId: context.traceId,
        requestId: context.requestId,
        userId: context.userId,
        apiKeyId: context.apiKeyId,
        requestedModel: context.requestedModel,
        isStream: true,
        startedAt: context.startedAt,
      });
      logId = started?.id ?? null;
    } catch (error) {
      this.reportLoggingFailure('request-log.start', error, context.traceId);
    }

    // `timeout` is a gateway option, never forwarded to a provider.
    const { timeout, ...providerRequest } = request;
    const includeUsage = request.stream_options?.include_usage === true;
    const budgetDeadline =
      timeout !== undefined ? context.startedAt.getTime() + timeout : undefined;

    const pendingWrites: Promise<void>[] = [];
    let attemptCount = 0;
    let fallbackUsed = false;
    const observed = { last: null as AttemptObservation<StreamOutcome> | null };

    const onAttempt = (observation: AttemptObservation<StreamOutcome>) => {
      observed.last = observation;
      attemptCount += 1;
      fallbackUsed = fallbackUsed || observation.isFallback;

      this.recordAttempt(
        observation,
        context,
        logId,
        {
          isStream: true,
          timeToFirstTokenMs:
            observation.result?.timeToFirstTokenMs ?? null,
        },
        pendingWrites,
      );
    };

    try {
      // Routing is inside the guard so `MODEL_NOT_FOUND` leaves a finalized row
      // rather than a PROCESSING one for the sweep.
      const routing = await this.router.resolveRoute(request.model);

      const result = await this.resilience.execute(
        routing.targets,
        (target, timeoutMs) =>
          this.streamThroughProvider(
            target,
            providerRequest,
            timeoutMs,
            context,
            sink,
            includeUsage,
            budgetDeadline,
          ),
        {
          ...(timeout !== undefined ? { budgetMs: timeout } : {}),
          onAttempt,
        },
      );

      // `[DONE]` first: the client's answer is complete, and the logging writes
      // below must not add their latency to a response the user is reading.
      sink.end();

      await Promise.allSettled(pendingWrites);

      const usage = result.response.usage;
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
            traceId: context.traceId,
            statusCode: 200,
            modelId: result.target.modelId,
            requestedModel: context.requestedModel,
            servedModel: result.response.model,
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

      try {
        this.telemetry.logRequest({
          traceId: context.traceId,
          userId: context.userId,
          apiKeyId: context.apiKeyId ?? undefined,
          modelId: result.target.modelId,
          provider: result.target.provider,
          statusCode: 200,
          // Same meaning as the blocking path: time spent in the provider,
          // not time spent writing logs.
          latencyMs: result.latencyMs,
          promptTokens: promptTokens ?? undefined,
          completionTokens: completionTokens ?? undefined,
          totalTokens: totalTokens ?? undefined,
        });
      } catch (telemetryError) {
        this.reportTelemetryFailure(
          'telemetry.logRequest',
          telemetryError,
          context.traceId,
        );
      }
    } catch (error) {
      const classification = this.classifyStreamFailure(error);
      // Captured before the sink closes: after `fail()` it is no longer open,
      // but the decision "the client already has bytes" must not change.
      const committed = sink.isOpen;

      if (committed && !sink.aborted) {
        sink.fail({
          code: classification.wireCode,
          message: classification.message,
          type: errorTypeForStatus(classification.httpStatus),
          traceId: context.traceId,
          statusCode: classification.httpStatus,
        });
      }

      await Promise.allSettled(pendingWrites);

      if (logId !== null) {
        try {
          await this.requestLogs.finalizeFailure({
            requestLogId: logId,
            traceId: context.traceId,
            statusCode: classification.httpStatus,
            failureClass: classification.failureClass,
            errorCode: classification.wireCode,
            errorMessage: sanitizeErrorMessage(error),
            modelId: observed.last?.target.modelId ?? null,
            provider: observed.last?.target.provider ?? null,
            servedModel:
              observed.last?.status === 'SUCCEEDED'
                ? (observed.last.result?.response?.model ??
                  observed.last.target.upstreamModel)
                : null,
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

      try {
        this.telemetry.logError({
          traceId: context.traceId,
          errorCode: classification.wireCode,
          errorMessage: sanitizeErrorMessage(error) ?? 'unknown',
          statusCode: classification.httpStatus,
        });
      } catch (telemetryError) {
        this.reportTelemetryFailure(
          'telemetry.logError',
          telemetryError,
          context.traceId,
        );
      }

      // Before the first byte the controller still owns an ordinary response,
      // so the error keeps travelling. After it, the SSE frame was the answer.
      if (!committed) {
        throw error;
      }
    }
  }

  /**
   * One streaming attempt, from opening the provider stream to its last chunk.
   *
   * Owns the two limits the blocking path does not need: an idle timeout that
   * aborts a provider which stopped talking, and the client's total budget.
   * Aborting the controller destroys the upstream socket, so an abandoned
   * request stops costing money.
   */
  private async streamThroughProvider(
    target: RouteTarget,
    request: Omit<ChatCompletionRequest, 'timeout'>,
    timeoutMs: number,
    context: RequestContext,
    sink: StreamSink,
    includeUsage: boolean,
    budgetDeadline: number | undefined,
  ): Promise<StreamOutcome> {
    const credential = this.credentials.resolve(
      target.provider,
      target.baseUrl,
    );
    const controller = new AbortController();
    let clientGone = false;
    let idleExpired = false;

    const onClientAbort = () => {
      clientGone = true;
      controller.abort();
    };

    if (sink.signal.aborted) {
      onClientAbort();
    } else {
      sink.signal.addEventListener('abort', onClientAbort, { once: true });
    }

    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const clearIdle = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(
        () => {
          idleExpired = true;
          controller.abort();
        },
        Math.max(1, timeoutMs),
      );
      idleTimer.unref();
    };

    const upstreamStart = Date.now();
    let firstChunkAt: number | null = null;
    let completed = false;
    let id = `chatcmpl_${context.traceId}`;
    let model = target.upstreamModel;
    let created = Math.floor(Date.now() / 1000);
    let usage: ChatCompletionChunk['usage'] | undefined;

    try {
      const stream = this.providers.streamChatCompletion(
        target.provider,
        { ...request, model: target.upstreamModel },
        {
          baseUrl: credential.baseUrl,
          apiKey: credential.apiKey,
          timeoutMs,
          signal: controller.signal,
        },
        context.traceId,
      );

      armIdle();

      for await (const chunk of stream) {
        if (clientGone) {
          throw this.clientDisconnected();
        }

        if (idleExpired) {
          throw firstChunkAt === null
            ? new ProviderError('PROVIDER_TIMEOUT', 'Provider request timed out')
            : this.streamInterrupted(
                'TIMEOUT',
                504,
                'The provider stopped sending tokens.',
              );
        }

        if (budgetDeadline !== undefined && Date.now() > budgetDeadline) {
          throw firstChunkAt === null
            ? new ProviderError(
                'PROVIDER_TIMEOUT',
                'Request timeout budget exhausted',
              )
            : this.streamInterrupted(
                'TIMEOUT',
                504,
                'Request timeout budget exhausted',
              );
        }

        id = chunk.id || id;
        model = chunk.model || model;
        created = chunk.created || created;
        if (chunk.usage) {
          usage = { ...usage, ...chunk.usage };
        }
        if (chunk.choices.some((choice) => choice.finish_reason !== null)) {
          completed = true;
        }

        // A usage-only chunk carries no content. It is accumulated above and
        // re-emitted once, after the finish chunk, only when the client opted
        // in - which is exactly what the OpenAI format documents.
        if (chunk.choices.length === 0) {
          continue;
        }

        const outbound: ChatCompletionChunk = {
          ...chunk,
          id,
          model,
          created,
          trace_id: context.traceId,
        };
        delete outbound.usage;

        if (firstChunkAt === null) {
          firstChunkAt = Date.now();
          sink.open();
        }

        armIdle();
        await sink.write(outbound);
      }

      if (clientGone) {
        throw this.clientDisconnected();
      }

      if (idleExpired) {
        throw this.streamInterrupted(
          'TIMEOUT',
          504,
          'The provider stopped sending tokens.',
        );
      }

      if (!completed) {
        // A clean end with no finish chunk is a provider that closed early.
        // Before the first byte it is still retryable; after it, it is the
        // truncation the client has to be told about.
        throw firstChunkAt === null
          ? new ProviderError(
              'PROVIDER_ERROR',
              'The provider stream ended before sending any tokens.',
            )
          : this.streamInterrupted(
              'PROVIDER_ERROR',
              502,
              'The provider stream ended before the completion finished.',
            );
      }

      if (includeUsage && usage) {
        sink.open();
        await sink.write({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage,
          trace_id: context.traceId,
        });
      }

      return {
        target,
        response: { id, model, ...(usage ? { usage } : {}) },
        latencyMs: Date.now() - upstreamStart,
        timeToFirstTokenMs:
          firstChunkAt === null ? null : firstChunkAt - upstreamStart,
      };
    } catch (error) {
      if (clientGone) {
        throw this.clientDisconnected();
      }

      if (idleExpired) {
        throw firstChunkAt === null
          ? new ProviderError('PROVIDER_TIMEOUT', 'Provider request timed out')
          : this.streamInterrupted(
              'TIMEOUT',
              504,
              'The provider stopped sending tokens.',
            );
      }

      if (error instanceof StreamCommittedError) {
        throw error;
      }

      // Anything that fails after the first chunk is terminal: wrapping it in a
      // non-provider error is what stops the resilience loop retrying.
      if (firstChunkAt !== null) {
        throw this.committedFailure(error);
      }

      throw error;
    } finally {
      clearIdle();
      sink.signal.removeEventListener('abort', onClientAbort);
    }
  }

  private clientDisconnected(): StreamCommittedError {
    const classified = classifiedFromDefinition('CLIENT_DISCONNECTED');

    return new StreamCommittedError(classified.message, classified);
  }

  private streamInterrupted(
    failureClass: FailureClass,
    httpStatus: number,
    message: string,
  ): StreamCommittedError {
    return new StreamCommittedError(message, {
      ...classifiedFromDefinition('STREAM_INTERRUPTED'),
      failureClass,
      httpStatus,
      message,
    });
  }

  private committedFailure(error: unknown): StreamCommittedError {
    if (error instanceof ProviderError) {
      const classified = classifyProviderError(error);
      return new StreamCommittedError(classified.message, classified);
    }

    const classified = classifiedFromDefinition('STREAM_INTERRUPTED');
    return new StreamCommittedError(classified.message, classified);
  }

  private classifyStreamFailure(error: unknown): ClassifiedError {
    if (error instanceof StreamCommittedError) {
      return error.classified;
    }

    try {
      return classifyException(error);
    } catch {
      return classifiedFromDefinition('INTERNAL_ERROR');
    }
  }

  /**
   * Records a request rejected before routing as a caller fault (§6.1/§8.3 #5).
   *
   * The row is written before the exception leaves the controller so the most
   * common caller error (invalid body, unsupported feature) leaves evidence.
   * No attempts are ever attached: the request never reached a provider.
   *
   * Fully wrapped: a logging failure must not turn the caller's 400 into a 500.
   */
  async recordRejectedRequest(
    context: RequestContext,
    input: {
      code: 'VALIDATION_ERROR' | 'UNSUPPORTED_FEATURE';
      message: string;
    },
  ): Promise<void> {
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

      if (!started) {
        return;
      }

      await this.requestLogs.finalizeFailure({
        requestLogId: started.id,
        traceId: context.traceId,
        statusCode: 400,
        failureClass: 'CALLER_FAULT',
        errorCode: input.code,
        errorMessage: sanitizeErrorMessage(input.message),
        attemptCount: 0,
        fallbackUsed: false,
        latencyMs: 0,
        finishedAt: new Date(),
      });
    } catch (error) {
      this.reportLoggingFailure(
        'recordRejectedRequest',
        error,
        context.traceId,
      );
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
   * Queues the attempt row for one observation.
   *
   * Started, never awaited inline: a hung request must leave the attempts that
   * already happened on disk (§6.2). A missing parent row means an orphan
   * would be worse than nothing, so nothing is written.
   */
  private recordAttempt(
    observation: AttemptObservation<AttemptResult>,
    context: RequestContext,
    logId: string | null,
    options: AttemptMappingOptions,
    pendingWrites: Promise<void>[],
  ): void {
    const parentId = logId;

    if (parentId === null) {
      return;
    }

    pendingWrites.push(
      (async () => {
        const draft = this.toDraft(observation, context.traceId, options);

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
            traceId: context.traceId,
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
  }

  /**
   * The single mapping from an observation to an attempt draft (§5.7).
   *
   * Returns `null` when the mapping itself fails: the draft is the only input
   * `appendAttempt` accepts, so there is nothing safe to write without it.
   */
  private toDraft(
    observation: AttemptObservation<AttemptResult>,
    traceId: string,
    options: AttemptMappingOptions,
  ) {
    try {
      return toAttemptRecord(observation, classifyAttemptError, options);
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

    // TOTAL: the reporter runs on the response path, so a throwing sink must
    // degrade to the logger instead of escaping and changing the response.
    try {
      this.telemetry.logError({
        traceId,
        errorCode: 'REQUEST_LOG_WRITE_FAILED',
        errorMessage,
        statusCode: 0,
      });
    } catch (telemetryError) {
      this.reportTelemetryFailure(scope, telemetryError, traceId);
    }

    // The logger is the last line: a throwing one must not escape either.
    try {
      this.logger.error(`[${traceId}] ${errorMessage}`);
    } catch {
      // Nothing left to report to.
    }
  }

  /**
   * Last line for a throwing telemetry sink.
   *
   * Only logs: calling `reportLoggingFailure` here would recurse back into the
   * sink that just threw.
   */
  private reportTelemetryFailure(
    scope: string,
    error: unknown,
    traceId: string,
  ): void {
    try {
      this.logger.error(
        `[${traceId}] ${scope}: telemetry sink failed: ${
          sanitizeErrorMessage(error) ?? 'unknown'
        }`,
      );
    } catch {
      // TOTAL: a throwing Logger must not change a response (S1).
    }
  }
}
