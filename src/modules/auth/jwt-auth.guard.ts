import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

interface JwtPayload {
  sub?: string;
  email?: string;
  role?: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers?.authorization;

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw this.unauthorized();
    }

    const token = header.slice('Bearer '.length).trim();

    if (!token) {
      throw this.unauthorized();
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw this.unauthorized();
    }

    if (!payload.sub) {
      throw this.unauthorized();
    }

    const user = await this.authService.getJwtUser(payload.sub);
    if (!user) {
      throw this.unauthorized();
    }

    request.user = user;
    return true;
  }

  private unauthorized() {
    return new UnauthorizedException({
      code: 'AUTHENTICATION_ERROR',
      message: 'Invalid or expired token',
      statusCode: 401,
    });
  }
}
