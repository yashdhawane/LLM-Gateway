import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * Validates opaque bearer API keys (`lg_...`).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers?.authorization;
    const apiKey =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : undefined;

    if (!apiKey) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_ERROR',
        message: 'API key required',
        statusCode: 401,
      });
    }

    request.user = await this.authService.validateApiKey(apiKey);
    return true;
  }
}
