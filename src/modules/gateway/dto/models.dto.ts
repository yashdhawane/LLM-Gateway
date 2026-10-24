import { ApiProperty } from '@nestjs/swagger';

export class ModelDto {
  @ApiProperty({ example: 'mock' })
  id!: string;

  @ApiProperty({ example: 'model' })
  object!: string;

  @ApiProperty({ example: 1761319216 })
  created!: number;

  @ApiProperty({ example: 'mock' })
  owned_by!: string;
}

export class ModelListDto {
  @ApiProperty({ example: 'list' })
  object!: string;

  @ApiProperty({ type: [ModelDto] })
  data!: ModelDto[];
}
