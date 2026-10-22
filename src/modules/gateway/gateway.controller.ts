import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  InternalServerErrorException,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { RouterService } from '../router/router.service';
import { ProviderService } from '../providers/provider.service';
import { ChatCompletionRequestSchema, ChatCompletionRequest } from '../router/schemas/chat-completion.schema';
import { ErrorCode } from '../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, TraceId } from '../../common/decorators';
import { AuthenticatedUser } from '../auth/auth.service';
import { TelemetryService } from '../telemetry/telemetry.module';

@ApiTags('chat')
@ApiBearerAuth('api-key')
@Controller('chat/completions')
export class GatewayController {
  constructor(
    private readonly routerService: RouterService,
    private readonly providerService: ProviderService,
    private readonly prisma: PrismaService,
    @Inject(TelemetryService) private readonly telemetry: TelemetryService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  @ApiOperation({ summary: 'Create a chat completion' })
  @ApiResponse({ status: 200, description: 'Chat completion successful' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Model not found' })
  @ApiResponse({ status: 502, description: 'Provider error' })
  @ApiResponse({ status: 504, description: 'Provider timeout' })
  async createCompletion(
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
  ) {
    // Validate request body with Zod
    const parseResult = ChatCompletionRequestSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid request body',
        statusCode: 400,
        traceId,
      });
    }

    const request: ChatCompletionRequest = parseResult.data;

    // Resolve route
    let routingDecision;
    try {
      routingDecision = await this.routerService.resolveRoute(request.model);
    } catch (error: any) {
      throw new BadRequestException({
        code: error.code || ErrorCode.MODEL_NOT_FOUND,
        message: error.message || 'Model not found',
        statusCode: error.statusCode || 404,
        traceId,
      });
    }

    // Determine provider options
    const providerOptions = {
      baseUrl: routingDecision.baseUrl,
      apiKey: this.config.get<string>('OPENAI_API_KEY'),
      timeoutMs: request.timeout ?? routingDecision.timeoutMs,
    };

    // Call provider
    let providerResponse;
    try {
      providerResponse = await this.providerService.chatCompletion(
        routingDecision.provider,
        request,
        providerOptions,
        traceId,
      );
    } catch (error: any) {
      // Handle provider errors
      if (error.message === 'PROVIDER_TIMEOUT') {
        throw new InternalServerErrorException({
          code: ErrorCode.PROVIDER_TIMEOUT,
          message: 'Provider request timed out',
          statusCode: 504,
          traceId,
        });
      }

      throw new InternalServerErrorException({
        code: ErrorCode.PROVIDER_ERROR,
        message: error.message || 'Provider error',
        statusCode: 502,
        traceId,
      });
    }

    // Persist request log
    await this.prisma.requestLog.create({
      data: {
        traceId,
        requestId: request.user ?? '',
        userId: user.id,
        apiKeyId: user.apiKeyId,
        modelId: routingDecision.modelId,
        provider: routingDecision.provider,
        statusCode: 200,
        latencyMs: providerResponse.latencyMs,
        promptTokens: providerResponse.response.usage?.prompt_tokens ?? null,
        completionTokens: providerResponse.response.usage?.completion_tokens ?? null,
        totalTokens: providerResponse.response.usage?.total_tokens ?? null,
        cost: null, // Don't fabricate cost
        errorCode: null,
        errorMessage: null,
      },
    });

    // Emit telemetry event
    this.telemetry.logRequest({
      traceId,
      userId: user.id,
      apiKeyId: user.apiKeyId,
      modelId: routingDecision.modelId,
      provider: routingDecision.provider,
      statusCode: 200,
      latencyMs: providerResponse.latencyMs,
      promptTokens: providerResponse.response.usage?.prompt_tokens ?? undefined,
      completionTokens: providerResponse.response.usage?.completion_tokens ?? undefined,
      totalTokens: providerResponse.response.usage?.total_tokens ?? undefined,
      cost: undefined,
    });

    // Return response with trace ID
    return {
      ...providerResponse.response,
      trace_id: traceId,
    };
  }
}