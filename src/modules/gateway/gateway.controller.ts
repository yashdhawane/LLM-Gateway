import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
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
import { ProviderError } from '../providers/base.provider';
import {
  ChatRequestValidationError,
  validateChatCompletionRequest,
} from '../router/schemas/chat-completion.schema';
import { ApiErrorResponseDto } from '../../common/dto/api-error.dto';
import { CurrentUser, RequestId, TraceId } from '../../common/decorators';
import { AuthenticatedUser } from '../auth/auth.service';
import { GatewayService } from './gateway.service';
import {
  ChatCompletionRequestDto,
  ChatCompletionResponseDto,
} from './dto/chat-completion.dto';

@ApiTags('chat')
@ApiBearerAuth('api-key')
@Controller('chat/completions')
export class GatewayController {
  constructor(private readonly gatewayService: GatewayService) {}

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
    description: 'Provider credentials are not configured or the provider is unsupported',
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
    const request = this.validateRequest(body);

    try {
      return await this.gatewayService.createCompletion(request, {
        user,
        traceId,
        requestId,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        throw this.mapProviderError(error);
      }
      throw error;
    }
  }

  private validateRequest(body: unknown) {
    try {
      return validateChatCompletionRequest(body);
    } catch (error) {
      if (!(error instanceof ChatRequestValidationError)) {
        throw error;
      }
      throw new HttpException(
        {
          code: error.code,
          message: error.message,
          param: error.param,
          statusCode: HttpStatus.BAD_REQUEST,
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private mapProviderError(error: ProviderError): HttpException {
    const statusByCode = {
      PROVIDER_TIMEOUT: HttpStatus.GATEWAY_TIMEOUT,
      PROVIDER_RATE_LIMIT: HttpStatus.TOO_MANY_REQUESTS,
      PROVIDER_BAD_REQUEST: HttpStatus.BAD_REQUEST,
      PROVIDER_UNAVAILABLE: HttpStatus.BAD_GATEWAY,
      PROVIDER_NOT_CONFIGURED: HttpStatus.SERVICE_UNAVAILABLE,
      PROVIDER_ERROR: HttpStatus.BAD_GATEWAY,
    } satisfies Record<ProviderError['code'], number>;
    const messageByCode = {
      PROVIDER_TIMEOUT: 'Provider request timed out.',
      PROVIDER_RATE_LIMIT: 'Provider rate limit exceeded.',
      PROVIDER_BAD_REQUEST: 'Provider rejected the request.',
      PROVIDER_UNAVAILABLE: 'Provider is unavailable.',
      PROVIDER_NOT_CONFIGURED: 'Provider is not configured.',
      PROVIDER_ERROR: 'Provider request failed.',
    } satisfies Record<ProviderError['code'], string>;

    const status = statusByCode[error.code];
    return new HttpException(
      {
        code: error.code,
        message: messageByCode[error.code],
        statusCode: status,
      },
      status,
    );
  }
}
