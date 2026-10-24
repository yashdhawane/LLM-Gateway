import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  getAllUserInsights() {
    return this.insightsService.getAllUserInsights();
  }
}
