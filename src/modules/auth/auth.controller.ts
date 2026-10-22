import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { ApiKeyGuard } from './api-key.guard';
import { CurrentUser, TraceId } from '../../common/decorators';
import { AuthenticatedUser } from './auth.service';

@ApiTags('auth')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('keys')
  @ApiOperation({ summary: 'Create a new API key' })
  @ApiResponse({ status: 201, description: 'API key created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  createKey(
    @Body() body: { name?: string },
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
  ) {
    return this.authService.createApiKey(
      user.id,
      body?.name ?? 'default',
      user.ownerId,
      user.ownerType,
    );
  }

  @Get('keys')
  @ApiOperation({ summary: 'List all API keys for the current user' })
  @ApiResponse({ status: 200, description: 'API keys listed' })
  listKeys(
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
  ) {
    return this.authService.listApiKeys(user.id);
  }

  @Delete('keys/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({ status: 204, description: 'API key revoked' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  revokeKey(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
  ) {
    return this.authService.revokeApiKey(user.id, id);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'User profile' })
  getProfile(
    @CurrentUser() user: AuthenticatedUser,
    @TraceId() traceId: string,
  ) {
    return this.authService.getUserById(user.id);
  }
}