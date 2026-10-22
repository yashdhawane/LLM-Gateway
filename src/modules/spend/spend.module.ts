import { Module, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SpendService implements OnModuleInit {
  private readonly logger = new Logger(SpendService.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.eventEmitter.on('request.logged', this.handleRequestLogged.bind(this));
  }

  private async handleRequestLogged(event: {
    traceId: string;
    userId: string;
    apiKeyId?: string;
    modelId?: string;
    provider?: string;
    statusCode: number;
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cost?: number;
    errorCode?: string;
    errorMessage?: string;
  }) {
    // Spend is already persisted in RequestLog via the gateway controller
    // This service can be extended for real-time spend events, aggregations, etc.
    this.logger.debug(
      `[${event.traceId}] Spend event: ${event.cost ?? 'unknown'} for user ${event.userId}`,
    );
  }

  async getSpendByUser(userId: string, startDate?: Date, endDate?: Date) {
    return this.prisma.requestLog.aggregate({
      where: {
        userId,
        createdAt: {
          ...(startDate && { gte: startDate }),
          ...(endDate && { lte: endDate }),
        },
      },
      _sum: { cost: true },
      _count: { id: true },
    });
  }

  async getSpendByApiKey(apiKeyId: string, startDate?: Date, endDate?: Date) {
    return this.prisma.requestLog.aggregate({
      where: {
        apiKeyId,
        createdAt: {
          ...(startDate && { gte: startDate }),
          ...(endDate && { lte: endDate }),
        },
      },
      _sum: { cost: true },
      _count: { id: true },
    });
  }
}

@Module({
  providers: [SpendService],
  exports: [SpendService],
})
export class SpendModule {}