import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface RouteConfig {
  model: string;
  provider: string;
  baseUrl?: string;
  timeoutMs: number;
}

export interface RoutingDecision {
  modelId: string;
  modelName: string;
  provider: string;
  baseUrl?: string;
  timeoutMs: number;
}

@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);
  private routeCache = new Map<string, RouteConfig>();

  constructor(private readonly prisma: PrismaService) {}

  async resolveRoute(modelName: string): Promise<RoutingDecision> {
    // Check cache first
    const cached = this.routeCache.get(modelName);
    if (cached) {
      return {
        modelId: cached.model,
        modelName: modelName,
        provider: cached.provider,
        baseUrl: cached.baseUrl,
        timeoutMs: cached.timeoutMs,
      };
    }

    // Look up in database
    const model = await this.prisma.model.findUnique({
      where: { name: modelName },
    });

    if (!model || !model.isActive) {
      throw new NotFoundException({
        code: 'MODEL_NOT_FOUND',
        message: `Model '${modelName}' not found or inactive`,
        statusCode: 404,
      });
    }

    const route: RouteConfig = {
      model: model.id,
      provider: model.provider,
      baseUrl: model.baseUrl ?? undefined,
      timeoutMs: model.timeoutMs,
    };

    this.routeCache.set(modelName, route);

    return {
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      baseUrl: model.baseUrl ?? undefined,
      timeoutMs: model.timeoutMs,
    };
  }

  async invalidateCache(modelName: string) {
    this.routeCache.delete(modelName);
  }
}