import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.service';
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

interface RequestContext {
  user: AuthenticatedUser;
  traceId: string;
  requestId: string;
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly router: RouterService,
    private readonly providers: ProviderService,
    private readonly prisma: PrismaService,
    private readonly telemetry: TelemetryService,
    private readonly credentials: CredentialManager,
    private readonly resilience: ResilienceService,
  ) {}

  async createCompletion(
    request: ChatCompletionRequest,
    context: RequestContext,
  ): Promise<ChatCompletionResponse> {
    const routing = await this.router.resolveRoute(request.model);
    const { timeout, ...providerRequest } = request;

    const result = await this.resilience.execute(
      routing.targets,
      (target, timeoutMs) =>
        this.callProvider(target, providerRequest, timeoutMs, context.traceId),
      timeout !== undefined ? { budgetMs: timeout } : undefined,
    );

    await this.recordSuccessfulRequest(result.target, result.response, context);

    this.telemetry.logRequest({
      traceId: context.traceId,
      userId: context.user.id,
      apiKeyId: context.user.apiKeyId,
      modelId: result.target.modelId,
      provider: result.target.provider,
      statusCode: 200,
      latencyMs: result.response.latencyMs,
      promptTokens: result.response.response.usage?.prompt_tokens,
      completionTokens: result.response.response.usage?.completion_tokens,
      totalTokens: result.response.response.usage?.total_tokens,
    });

    return {
      ...result.response.response,
      trace_id: context.traceId,
    };
  }

  private async callProvider(
    target: RouteTarget,
    request: Omit<ChatCompletionRequest, 'timeout'>,
    timeoutMs: number,
    traceId: string,
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
        traceId,
      ),
    };
  }

  private async recordSuccessfulRequest(
    target: RouteTarget,
    response: ProviderResponse,
    context: RequestContext,
  ): Promise<void> {
    try {
      await this.prisma.requestLog.create({
        data: {
          traceId: context.traceId,
          requestId: context.requestId,
          userId: context.user.id,
          apiKeyId: context.user.apiKeyId,
          modelId: target.modelId,
          provider: target.provider,
          statusCode: 200,
          latencyMs: response.latencyMs,
          promptTokens: response.response.usage?.prompt_tokens ?? null,
          completionTokens: response.response.usage?.completion_tokens ?? null,
          totalTokens: response.response.usage?.total_tokens ?? null,
          cost: null,
          errorCode: null,
          errorMessage: null,
        },
      });
    } catch (error) {
      const details =
        error instanceof Error ? error.stack ?? error.message : String(error);

      this.logger.error(
        `[${context.traceId}] Provider succeeded but request log persistence failed`,
        details,
      );
    }
  }
}
