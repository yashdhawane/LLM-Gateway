import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class InsightsService {
  constructor(private readonly prisma: PrismaService) {}

  async getUserInsights(userId: string) {
    const [summary, recentRequests] = await Promise.all([
      this.prisma.requestLog.aggregate({
        where: { userId },
        _count: { _all: true },
        _sum: {
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
        },
        _max: { createdAt: true },
      }),
      this.prisma.requestLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          traceId: true,
          provider: true,
          statusCode: true,
          latencyMs: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          errorCode: true,
          createdAt: true,
          model: { select: { name: true } },
        },
      }),
    ]);

    return {
      summary: {
        totalRequests: summary._count._all,
        promptTokens: summary._sum.promptTokens ?? 0,
        completionTokens: summary._sum.completionTokens ?? 0,
        totalTokens: summary._sum.totalTokens ?? 0,
        lastRequestAt: summary._max.createdAt,
      },
      recentRequests,
    };
  }

  async getAllUserInsights() {
    const [users, usage] = await Promise.all([
      this.prisma.user.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
          _count: {
            select: {
              apiKeys: true,
              requestLogs: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.requestLog.groupBy({
        by: ['userId'],
        _sum: {
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
        },
        _max: { createdAt: true },
      }),
    ]);

    const usageByUser = new Map(
      usage.map((row) => [row.userId, row] as const),
    );

    return {
      totalUsers: users.length,
      users: users.map((user) => {
        const row = usageByUser.get(user.id);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          createdAt: user.createdAt,
          apiKeyCount: user._count.apiKeys,
          totalRequests: user._count.requestLogs,
          promptTokens: row?._sum.promptTokens ?? 0,
          completionTokens: row?._sum.completionTokens ?? 0,
          totalTokens: row?._sum.totalTokens ?? 0,
          lastRequestAt: row?._max.createdAt ?? null,
        };
      }),
    };
  }
}
