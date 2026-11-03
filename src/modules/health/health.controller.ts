import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Readiness probe.
 *
 * Answers one question: can this process serve a request right now? The
 * database is part of that answer - without it every route that matters fails
 * - so an unusable database returns 503 and a monitor can act on it.
 *
 * Deliberately unauthenticated: a monitor has no API key or JWT. It exposes
 * only liveness (no version, no configuration, no secrets), and `app.setup`
 * keeps it outside the global `api/v1` prefix so the URL stays `/health`.
 */

const UP = 'up';
const DOWN = 'down';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
  uptimeSeconds: number;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  /**
   * A hung pooler connection must not hang the probe itself.
   *
   * Static so a test can shrink the bound instead of waiting two seconds.
   */
  static readonly DB_PROBE_TIMEOUT_MS = 2000;

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Readiness probe: process and database' })
  @ApiResponse({
    status: 200,
    description: 'Process is up and the database answers',
  })
  @ApiResponse({
    status: 503,
    description: 'Process is up but the database does not answer',
  })
  async check(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<HealthResponse> {
    const dbUp = (await this.probeDatabase()) === UP;

    // Passthrough keeps Nest in charge of the body while letting the probe
    // choose its own status code.
    reply.status(dbUp ? 200 : 503);

    return {
      status: dbUp ? 'ok' : 'degraded',
      db: dbUp ? UP : DOWN,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  /**
   * One round trip, bounded, never throws.
   *
   * A rejected query and a query that never answers both mean "not usable",
   * but `Promise.race` cannot tell them apart on its own (the timer would win
   * either way). The timer therefore resolves to `null`, which is distinct
   * from both a real answer and a rejection, and only an answer counts as up.
   */
  private async probeDatabase(): Promise<typeof UP | typeof DOWN> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(
          () => resolve(null),
          HealthController.DB_PROBE_TIMEOUT_MS,
        );
      });

      const probe: Promise<typeof UP | typeof DOWN> =
        this.prisma.$queryRaw`SELECT 1`.then(
          () => UP,
          () => DOWN,
        );

      const result = await Promise.race([probe, timeout]);

      return result ?? DOWN;
    } catch {
      return DOWN;
    } finally {
      // Cleared so a fast answer never leaves a timer behind.
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
