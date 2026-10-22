import {
  Injectable,
  UnauthorizedException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OwnerType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  apiKeyId: string;
  ownerId: string;
  ownerType: OwnerType;
}
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

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

  async createApiKey(
    userId: string,
    name: string,
    ownerId: string,
    ownerType: OwnerType,
  ) {
    const rawKey = `lg_${require('crypto').randomBytes(24).toString('hex')}`;
    const hashedKey = await bcrypt.hash(rawKey, 10);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        key: hashedKey,
        prefix: rawKey.substring(0, 11),
        name,
        ownerId,
        ownerType,
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