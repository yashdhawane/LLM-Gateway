import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InsightsService } from './insights.service';

@ApiTags('insights')
@ApiBearerAuth('jwt')
@Controller('insights')
@UseGuards(JwtAuthGuard)
export class InsightsController {
  constructor(private readonly insightsService: InsightsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get usage insights for the current user' })
  getMyInsights(@CurrentUser() user: JwtUser) {
    return this.insightsService.getUserInsights(user.id);
  }
}
