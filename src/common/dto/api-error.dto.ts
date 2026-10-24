import { ApiProperty } from '@nestjs/swagger';

export class ApiErrorDetailDto {
  @ApiProperty({ example: 'Unsupported request field.' })
  message!: string;

  @ApiProperty({
    enum: [
      'invalid_request_error',
      'authentication_error',
      'permission_error',
      'not_found_error',
      'conflict_error',
      'rate_limit_error',
      'server_error',
    ],
    example: 'invalid_request_error',
  })
  type!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Request field that caused the error, when applicable.',
  })
  param!: string | null;

  @ApiProperty({ example: 'UNSUPPORTED_FEATURE' })
  code!: string;

  @ApiProperty({
    required: false,
    example: '0f6f3d9d-5b6f-4b7e-9c2a-1f6f3d9d5b6f',
  })
  trace_id?: string;

  @ApiProperty({ example: 400 })
  status_code!: number;

  @ApiProperty({ example: '2026-10-24T15:20:16.452Z' })
  timestamp!: string;
}

export class ApiErrorResponseDto {
  @ApiProperty({ type: ApiErrorDetailDto })
  error!: ApiErrorDetailDto;
}
