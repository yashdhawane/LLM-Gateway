import {
  Injectable,
  UnauthorizedException,
  Logger,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OwnerType, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto, SignupDto } from './dto/auth.dto';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  apiKeyId: string;
  ownerId: string;
  ownerType: OwnerType;
}

export interface JwtUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async signup(dto: SignupDto) {
    const email = dto.email.trim().toLowerCase();
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      throw this.emailAlreadyExists();
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    try {
      const user = await this.prisma.user.create({
        data: {
          email,
          name: dto.name?.trim() || null,
          passwordHash,
          role: Role.DEVELOPER,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
        },
      });

      return this.createSession(user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw this.emailAlreadyExists();
      }

      throw error;
    }
  }

  async login(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        passwordHash: true,
      },
    });

    const validPassword =
      user?.passwordHash &&
      (await bcrypt.compare(dto.password, user.passwordHash));

    if (!user || !validPassword) {
      this.logger.warn(`Invalid login attempt for ${email}`);
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_ERROR',
        message: 'Invalid email or password',
        statusCode: 401,
      });
    }

    return this.createSession({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
  }

  async getJwtUser(userId: string): Promise<JwtUser | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
      },
    });
  }

  private async createSession(user: JwtUser) {
    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    return { accessToken, user };
  }

  private emailAlreadyExists() {
    return new ConflictException({
      code: 'EMAIL_ALREADY_EXISTS',
      message: 'An account with this email already exists',
      statusCode: 409,
    });
  }

  async validateApiKey(apiKey: string): Promise<AuthenticatedUser> {
    // Look up by a short key prefix, then verify the hash. The prefix is
    // intentionally longer than the static "lg_" marker so lookups are narrow.
    const prefix = apiKey.substring(0, 11);
    const candidates = await this.prisma.apiKey.findMany({
      where: { prefix, isActive: true },
      include: { user: true },
    });

    let apiKeyRecord: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await bcrypt.compare(apiKey, candidate.key)) {
        apiKeyRecord = candidate;
        break;
      }
    }

    if (!apiKeyRecord) {
      this.logger.warn(`Invalid API key attempt with prefix: ${prefix}`);
      throw new UnauthorizedException({
        code: 'API_KEY_INVALID',
        message: 'Invalid API key',
        statusCode: 401,
      });
    }

    // Update last used at
    await this.prisma.apiKey.update({
      where: { id: apiKeyRecord.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      id: apiKeyRecord.user.id,
      email: apiKeyRecord.user.email,
      role: apiKeyRecord.user.role,
      apiKeyId: apiKeyRecord.id,
      ownerId: apiKeyRecord.ownerId,
      ownerType: apiKeyRecord.ownerType,
    };
  }

  async createApiKey(userId: string, name: string) {
    const rawKey = `lg_${require('crypto').randomBytes(24).toString('hex')}`;
    const hashedKey = await bcrypt.hash(rawKey, 10);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        key: hashedKey,
        prefix: rawKey.substring(0, 11),
        name,
        ownerId: userId,
        ownerType: OwnerType.USER,
        userId,
      },
      select: {
        id: true,
        prefix: true,
        name: true,
        ownerId: true,
        ownerType: true,
        userId: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Return the raw key only once
    return { ...apiKey, rawKey };
  }

  async listApiKeys(userId: string) {
    return this.prisma.apiKey.findMany({
      where: { userId },
      select: {
        id: true,
        prefix: true,
        name: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async revokeApiKey(userId: string, apiKeyId: string) {
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id: apiKeyId },
    });

    if (!apiKey || apiKey.userId !== userId) {
      throw new ForbiddenException({
        code: 'AUTHORIZATION_ERROR',
        message: 'Access denied to this API key',
        statusCode: 403,
      });
    }

    return this.prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { isActive: false },
      select: {
        id: true,
        prefix: true,
        name: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async getUserById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });
  }
}
