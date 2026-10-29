import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface RouteTarget {
  modelId: string;
  modelName: string;
  upstreamModel: string;
  provider: string;
  baseUrl?: string;
  timeoutMs: number;
  maxRetries: number;
  cooldownMs: number;
}

export interface RoutingDecision {
  requestedModel: string;
  targets: RouteTarget[];
}

interface CacheEntry {
  decision: RoutingDecision;
  expiresAt: number;
}

@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);
  private readonly cacheTtlMs = 30_000;
  private routeCache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  async resolveRoute(modelName: string): Promise<RoutingDecision> {
    const cached = this.routeCache.get(modelName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.decision;
    }

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

    const fallbackNames = [
      ...new Set(
        (model.fallbackModels ?? [])
          .map((name) => name.trim())
          .filter((name) => name.length > 0 && name !== model.name),
      ),
    ];

    const fallbackModels = fallbackNames.length
      ? await this.prisma.model.findMany({
          where: {
            name: { in: fallbackNames },
            isActive: true,
          },
        })
      : [];

    const fallbackByName = new Map(
      fallbackModels.map((fallback) => [fallback.name, fallback]),
    );
    const orderedFallbacks = fallbackNames
      .map((name) => fallbackByName.get(name))
      .filter((fallback): fallback is NonNullable<typeof fallback> =>
        Boolean(fallback),
      );

    const decision: RoutingDecision = {
      requestedModel: model.name,
      targets: [model, ...orderedFallbacks].map((target) =>
        this.toTarget(target),
      ),
    };

    this.routeCache.set(modelName, {
      decision,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    this.logger.debug(
      `Resolved ${modelName} to ${decision.targets
        .map((target) => `${target.provider}/${target.modelName}`)
        .join(' -> ')}`,
    );

    return decision;
  }

  invalidateCache(modelName?: string) {
    if (modelName) {
      this.routeCache.delete(modelName);
      return;
    }

    this.routeCache.clear();
  }

  private toTarget(model: {
    id: string;
    name: string;
    provider: string;
    upstreamName: string | null;
    baseUrl: string | null;
    timeoutMs: number;
    maxRetries: number;
    cooldownMs: number;
  }): RouteTarget {
    return {
      modelId: model.id,
      modelName: model.name,
      upstreamModel: model.upstreamName?.trim() || model.name,
      provider: model.provider.trim().toLowerCase(),
      baseUrl: model.baseUrl?.trim() || undefined,
      timeoutMs: Math.max(1, model.timeoutMs),
      maxRetries: Math.min(5, Math.max(0, model.maxRetries)),
      cooldownMs: Math.min(300_000, Math.max(0, model.cooldownMs)),
    };
  }
}
