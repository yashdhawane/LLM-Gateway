import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../../common/dto/api-error.dto';
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
  @ApiResponse({
    status: 401,
    type: ApiErrorResponseDto,
    description: 'Unauthorized',
  })
  getMyInsights(@CurrentUser() user: JwtUser) {
    return this.insightsService.getUserInsights(user.id);
  }
}
