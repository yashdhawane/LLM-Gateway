import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiErrorResponseDto } from '../../common/dto/api-error.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ModelListDto } from './dto/models.dto';

@ApiTags('models')
@ApiBearerAuth('api-key')
@Controller('models')
export class ModelsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(ApiKeyGuard)
  @ApiOperation({ summary: 'List models available to the current API key' })
  @ApiOkResponse({ type: ModelListDto })
  @ApiResponse({ status: 401, type: ApiErrorResponseDto })
  async listModels() {
    const models = await this.prisma.model.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        name: true,
        provider: true,
        createdAt: true,
      },
    });

    return {
      object: 'list',
      data: models.map((model) => ({
        id: model.name,
        object: 'model',
        created: Math.floor(model.createdAt.getTime() / 1000),
        owned_by: model.provider,
      })),
    };
  }
}
