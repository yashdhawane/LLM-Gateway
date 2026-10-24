import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../../common/dto/api-error.dto';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InsightsService } from '../insights/insights.service';

@ApiTags('admin')
@ApiBearerAuth('jwt')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly insightsService: InsightsService) {}

  @Get('insights')
  @ApiOperation({ summary: 'Get usage insights for all users' })
  @ApiResponse({
    status: 401,
    type: ApiErrorResponseDto,
    description: 'Unauthorized',
  })
  @ApiResponse({
    status: 403,
    type: ApiErrorResponseDto,
    description: 'Admin role required',
  })
  getAllUserInsights() {
    return this.insightsService.getAllUserInsights();
  }
}
