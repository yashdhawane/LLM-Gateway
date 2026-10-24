import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatMessageDto {
  @ApiProperty({
    enum: ['system', 'user', 'assistant', 'developer'],
    example: 'user',
  })
  role!: string;

  @ApiProperty({ example: 'Hello from my application' })
  content!: string;

  @ApiPropertyOptional({ example: 'user-123' })
  name?: string;
}

export class ChatCompletionRequestDto {
  @ApiProperty({ example: 'mock' })
  model!: string;

  @ApiProperty({ type: [ChatMessageDto] })
  messages!: ChatMessageDto[];

  @ApiPropertyOptional({ example: 0.7, minimum: 0, maximum: 2 })
  temperature?: number;

  @ApiPropertyOptional({ example: 1, minimum: 0, maximum: 1 })
  top_p?: number;

  @ApiPropertyOptional({
    example: 1,
    description: 'Only n=1 is supported. Other values return UNSUPPORTED_FEATURE.',
  })
  n?: number;

  @ApiPropertyOptional({
    example: false,
    description:
      'Streaming is not supported yet. Set false or omit; true returns UNSUPPORTED_FEATURE.',
  })
  stream?: boolean;

  @ApiPropertyOptional({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['END'],
  })
  stop?: string | string[];

  @ApiPropertyOptional({ example: 256 })
  max_tokens?: number;

  @ApiPropertyOptional({ example: 256 })
  max_completion_tokens?: number;

  @ApiPropertyOptional({ example: 0, minimum: -2, maximum: 2 })
  presence_penalty?: number;

  @ApiPropertyOptional({ example: 0, minimum: -2, maximum: 2 })
  frequency_penalty?: number;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { '50256': -100 },
  })
  logit_bias?: Record<string, number>;

  @ApiPropertyOptional({ example: 'end-user-123' })
  user?: string;

  @ApiPropertyOptional({ example: 42 })
  seed?: number;

  @ApiPropertyOptional({
    example: 30000,
    description: 'Gateway-specific timeout in milliseconds.',
  })
  timeout?: number;
}

export class ChatCompletionResponseMessageDto {
  @ApiProperty({ example: 'assistant' })
  role!: string;

  @ApiPropertyOptional({ example: 'Hello! How can I help?' })
  content?: string;
}

export class ChatCompletionChoiceDto {
  @ApiProperty({ example: 0 })
  index!: number;

  @ApiProperty({ type: ChatCompletionResponseMessageDto })
  message!: ChatCompletionResponseMessageDto;

  @ApiProperty({ example: 'stop', nullable: true })
  finish_reason!: string | null;
}

export class ChatCompletionUsageDto {
  @ApiPropertyOptional({ example: 12 })
  prompt_tokens?: number;

  @ApiPropertyOptional({ example: 20 })
  completion_tokens?: number;

  @ApiPropertyOptional({ example: 32 })
  total_tokens?: number;
}

export class ChatCompletionResponseDto {
  @ApiProperty({ example: 'chatcmpl_mock_1761319216452' })
  id!: string;

  @ApiProperty({ example: 'chat.completion' })
  object!: string;

  @ApiProperty({ example: 1761319216 })
  created!: number;

  @ApiProperty({ example: 'mock' })
  model!: string;

  @ApiProperty({ type: [ChatCompletionChoiceDto] })
  choices!: ChatCompletionChoiceDto[];

  @ApiPropertyOptional({ type: ChatCompletionUsageDto })
  usage?: ChatCompletionUsageDto;

  @ApiPropertyOptional({ example: '0f6f3d9d-5b6f-4b7e-9c2a-1f6f3d9d5b6f' })
  trace_id?: string;
}
