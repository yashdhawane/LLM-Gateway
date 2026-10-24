import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { ApiErrorResponseDto } from '../../common/dto/api-error.dto';
import { AuthService, JwtUser } from './auth.service';
import { CreateApiKeyDto, LoginDto, SignupDto } from './dto/auth.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  @ApiOperation({ summary: 'Create a developer account' })
  @ApiResponse({ status: 201, description: 'Account created' })
  @ApiResponse({
    status: 400,
    type: ApiErrorResponseDto,
    description: 'Validation error',
  })
  @ApiResponse({
    status: 409,
    type: ApiErrorResponseDto,
    description: 'Email already registered',
  })
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in and receive a JWT' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({
    status: 400,
    type: ApiErrorResponseDto,
    description: 'Validation error',
  })
  @ApiResponse({
    status: 401,
    type: ApiErrorResponseDto,
    description: 'Invalid credentials',
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('keys')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Create a new API key' })
  @ApiResponse({ status: 201, description: 'API key created successfully' })
  @ApiResponse({
    status: 401,
    type: ApiErrorResponseDto,
    description: 'Unauthorized',
  })
  createKey(
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.authService.createApiKey(user.id, dto.name?.trim() || 'default');
  }

  @Get('keys')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'List all API keys for the current user' })
  @ApiResponse({ status: 200, description: 'API keys listed' })
  @ApiResponse({
    status: 401,
    type: ApiErrorResponseDto,
    description: 'Unauthorized',
  })
  listKeys(@CurrentUser() user: JwtUser) {
    return this.authService.listApiKeys(user.id);
  }

  @Delete('keys/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({ status: 204, description: 'API key revoked' })
  @ApiResponse({
    status: 401,
    type: ApiErrorResponseDto,
    description: 'Unauthorized',
  })
  @ApiResponse({
    status: 403,
    type: ApiErrorResponseDto,
    description: 'Forbidden',
  })
  revokeKey(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.authService.revokeApiKey(user.id, id);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'User profile' })
  @ApiResponse({
    status: 401,
    type: ApiErrorResponseDto,
    description: 'Unauthorized',
  })
  getProfile(@CurrentUser() user: JwtUser) {
    return this.authService.getUserById(user.id);
  }
}
