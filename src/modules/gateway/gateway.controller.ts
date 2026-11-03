import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  HttpException,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiProduces,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ProviderError } from '../providers/base.provider';
import {
  ChatRequestValidationError,
  validateChatCompletionRequest,
} from '../router/schemas/chat-completion.schema';
import { ApiErrorResponseDto } from '../../common/dto/api-error.dto';
import {
  classifyProviderError,
  toHttpException,
} from '../../common/errors/failure-classifier';
import { CurrentUser, RequestId, TraceId } from '../../common/decorators';
import {
  createRequestContext,
  requestedModelFromBody,
  type RequestContext,
} from '../../common/context/request-context';
import { AuthenticatedUser } from '../auth/auth.service';
import { createFastifyStreamSink } from '../../common/sse/fastify-stream-sink';
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
      'OpenAI-compatible text chat. Set `stream: true` to receive `text/event-stream` chunks terminated by `data: [DONE]`; omit it for a single JSON response. Unsupported features are rejected with a structured UNSUPPORTED_FEATURE error.',
  })
  @ApiProduces('application/json', 'text/event-stream')
  @ApiHeader({
    name: 'x-request-id',
    required: false,
    description:
      'Optional client request ID. Falls back to the gateway trace ID when omitted.',
  })
  @ApiBody({ type: ChatCompletionRequestDto })
  @ApiOkResponse({
    description:
      'One JSON completion, or an SSE stream when `stream` is true.',
    type: ChatCompletionResponseDto,
  })
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
    @Res() reply: FastifyReply,
  ) {
    // The controller owns context construction; the gateway receives an
    // immutable `RequestContext` and never sees the raw body (§6.1).
    const context = createRequestContext({
      user,
      traceId,
      requestId,
      requestedModel: requestedModelFromBody(body),
      isStream:
        typeof body === 'object' &&
        body !== null &&
        (body as Record<string, unknown>).stream === true,
    });

    const request = await this.validateRequest(body, context);

    if (context.isStream) {
      const sink = createFastifyStreamSink(reply, traceId);

      try {
        await this.gatewayService.streamCompletion(request, context, sink);
      } catch (error) {
        // Only a failure before the first byte reaches this point: the sink has
        // not committed anything, so a normal JSON error is still possible.
        if (error instanceof ProviderError) {
          throw this.mapProviderError(error);
        }
        throw error;
      }

      // A committed stream is already written by the sink; returning here keeps
      // Nest from attempting a second response.
      return;
    }

    try {
      reply.send(await this.gatewayService.createCompletion(request, context));
    } catch (error) {
      if (error instanceof ProviderError) {
        throw this.mapProviderError(error);
      }
      throw error;
    }
  }

  private async validateRequest(body: unknown, context: RequestContext) {
    try {
      return validateChatCompletionRequest(body);
    } catch (error) {
      if (!(error instanceof ChatRequestValidationError)) {
        throw error;
      }

      const exception = new HttpException(
        {
          code: error.code,
          message: error.message,
          param: error.param,
          statusCode: HttpStatus.BAD_REQUEST,
        },
        HttpStatus.BAD_REQUEST,
      );

      // Rejected requests still get a CALLER_FAULT row (§6.1). The optional
      // call keeps fakes that only implement `createCompletion` working, and
      // the surrounding try/catch keeps a logging failure out of the response.
      try {
        await this.gatewayService.recordRejectedRequest?.(context, {
          code: error.code,
          message: error.message,
        });
      } catch {
        // A logging failure must never change the caller's 400 (§S1).
      }

      // The identical exception the contract already promised.
      throw exception;
    }
  }

  private mapProviderError(error: ProviderError): HttpException {
    // Status code, wire code and client-facing message all come from the
    // shared taxonomy so the response contract has a single owner (§6.4).
    const exception = toHttpException(classifyProviderError(error));

    // A classified provider error always rebuilds an HttpException; anything
    // else is not ours to translate.
    if (!(exception instanceof HttpException)) {
      throw error;
    }

    return exception;
  }
}
