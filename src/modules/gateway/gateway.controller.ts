import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  HttpException,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { RouterService } from '../router/router.service';
import { ProviderService } from '../providers/provider.service';
import { ProviderError } from '../providers/base.provider';
import {
  ChatCompletionRequest,
  ChatRequestValidationError,
  validateChatCompletionRequest,
} from '../router/schemas/chat-completion.schema';
import { ErrorCode } from '../../common/filters/all-exceptions.filter';
import { ApiErrorResponseDto } from '../../common/dto/api-error.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, RequestId, TraceId } from '../../common/decorators';
import { AuthenticatedUser } from '../auth/auth.service';
import { TelemetryService } from '../telemetry/telemetry.module';
import {
  ChatCompletionRequestDto,
  ChatCompletionResponseDto,
} from './dto/chat-completion.dto';

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
  @ApiOperation({
    summary: 'Create a chat completion',
    description:
      'OpenAI-compatible, non-streaming text chat. Unsupported features are rejected with a structured UNSUPPORTED_FEATURE error.',
  })
  @ApiHeader({
    name: 'x-request-id',
    required: false,
    description:
      'Optional client request ID. Falls back to the gateway trace ID when omitted.',
  })
  @ApiBody({ type: ChatCompletionRequestDto })
  @ApiOkResponse({ type: ChatCompletionResponseDto })
  @ApiResponse({
    status: 400,
    type: ApiErrorResponseDto,
    description: 'Validation error or unsupported request feature',
  })
  @ApiResponse({
    status: 401,
    type: ApiErrorResponseDto,
    description: 'Missing or invalid API key',
  })
  @ApiResponse({
    status: 404,
    type: ApiErrorResponseDto,
    description: 'Model not found or inactive',
  })
  @ApiResponse({
    status: 429,
    type: ApiErrorResponseDto,
    description: 'Provider rate limit exceeded',
  })
  @ApiResponse({
    status: 502,
    type: ApiErrorResponseDto,
    description: 'Provider request failed',
  })
  @ApiResponse({
    status: 503,
    type: ApiErrorResponseDto,
    description: 'Provider credentials are not configured',
  })
  @ApiResponse({
    status: 504,
    type: ApiErrorResponseDto,
    description: 'Provider request timed out',
  })
  async createCompletion(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
    @RequestId() requestId: string,
  ) {
    let request: ChatCompletionRequest;
    try {
      request = validateChatCompletionRequest(body);
    } catch (error) {
      if (error instanceof ChatRequestValidationError) {
        throw new HttpException(
          {
            code: error.code,
            message: error.message,
            param: error.param,
            statusCode: 400,
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      throw error;
    }

    // Resolve route
    let routingDecision;
    try {
      routingDecision = await this.routerService.resolveRoute(request.model);
    } catch (error) {
      const status =
        error instanceof HttpException
          ? error.getStatus()
          : HttpStatus.NOT_FOUND;
      const responseBody =
        error instanceof HttpException ? (error.getResponse() as any) : {};

      throw new HttpException(
        {
          code: responseBody.code || ErrorCode.MODEL_NOT_FOUND,
          message:
            responseBody.message ||
            (error instanceof Error ? error.message : 'Model not found'),
          statusCode: status,
        },
        status,
      );
    }

    const { timeout: requestTimeout, ...providerRequest } = request;
    const providerOptions = {
      baseUrl: routingDecision.baseUrl,
      apiKey: this.config.get<string>('OPENAI_API_KEY'),
      timeoutMs: requestTimeout ?? routingDecision.timeoutMs,
    };

    const provider = this.providerService.getProvider(routingDecision.provider);
    if (provider.requiresApiKey && !providerOptions.apiKey) {
      throw new HttpException(
        {
          code: ErrorCode.PROVIDER_NOT_CONFIGURED,
          message: `Provider '${routingDecision.provider}' is not configured.`,
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // Call provider
    let providerResponse;
    try {
      providerResponse = await this.providerService.chatCompletion(
        routingDecision.provider,
        providerRequest,
        providerOptions,
        traceId,
      );
    } catch (error) {
      throw this.mapProviderError(error);
    }

    // Persist request log
    await this.prisma.requestLog.create({
      data: {
        traceId,
        requestId,
        userId: user.id,
        apiKeyId: user.apiKeyId,
        modelId: routingDecision.modelId,
        provider: routingDecision.provider,
        statusCode: 200,
        latencyMs: providerResponse.latencyMs,
        promptTokens: providerResponse.response.usage?.prompt_tokens ?? null,
        completionTokens:
          providerResponse.response.usage?.completion_tokens ?? null,
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
      completionTokens:
        providerResponse.response.usage?.completion_tokens ?? undefined,
      totalTokens: providerResponse.response.usage?.total_tokens ?? undefined,
      cost: undefined,
    });

    // Return response with trace ID
    return {
      ...providerResponse.response,
      trace_id: traceId,
    };
  }

  private mapProviderError(error: unknown): HttpException {
    if (error instanceof ProviderError) {
      switch (error.code) {
        case 'PROVIDER_TIMEOUT':
          return new HttpException(
            {
              code: ErrorCode.PROVIDER_TIMEOUT,
              message: 'Provider request timed out.',
              statusCode: HttpStatus.GATEWAY_TIMEOUT,
            },
            HttpStatus.GATEWAY_TIMEOUT,
          );
        case 'PROVIDER_RATE_LIMIT':
          return new HttpException(
            {
              code: ErrorCode.PROVIDER_RATE_LIMIT,
              message: 'Provider rate limit exceeded.',
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        case 'PROVIDER_BAD_REQUEST':
          return new HttpException(
            {
              code: ErrorCode.PROVIDER_BAD_REQUEST,
              message: 'Provider rejected the request.',
              statusCode: HttpStatus.BAD_REQUEST,
            },
            HttpStatus.BAD_REQUEST,
          );
        case 'PROVIDER_UNAVAILABLE':
          return new HttpException(
            {
              code: ErrorCode.PROVIDER_UNAVAILABLE,
              message: 'Provider is unavailable.',
              statusCode: HttpStatus.BAD_GATEWAY,
            },
            HttpStatus.BAD_GATEWAY,
          );
        default:
          return new HttpException(
            {
              code: ErrorCode.PROVIDER_ERROR,
              message: 'Provider request failed.',
              statusCode: HttpStatus.BAD_GATEWAY,
            },
            HttpStatus.BAD_GATEWAY,
          );
      }
    }

    return new HttpException(
      {
        code: ErrorCode.PROVIDER_ERROR,
        message: 'Provider request failed.',
        statusCode: HttpStatus.BAD_GATEWAY,
      },
      HttpStatus.BAD_GATEWAY,
    );
  }
}
