import { Injectable, Logger } from '@nestjs/common';
import { ModelPricing, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * A resolved, immutable price row. Only the fields the cost math needs are
 * copied, so the caller cannot accidentally depend on a mutable Prisma row.
 */
export interface PricingSnapshot {
  pricingId: string;
  currency: string;
  inputPricePerMillion: Prisma.Decimal;
  outputPricePerMillion: Prisma.Decimal;
}

export interface ResolvePricingInput {
  provider: string;
  /** Provider's upstream model id (`RouteTarget.upstreamModel`), not the alias. */
  model: string;
  userId?: string | null;
  at?: Date;
  /** ISO-4217; defaults to 'USD' so the cache key is always defined. */
  currency?: string;
}

interface PricingCacheEntry {
  snapshot: PricingSnapshot;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1000;
const DEFAULT_CURRENCY = 'USD';
const CANDIDATE_LIMIT = 10;

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);
  private readonly cache = new Map<string, PricingCacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the price row that applies to a request.
   *
   * Selection (§3.3), executed exactly:
   *  - `isActive = true`, matching `provider` + `model`;
   *  - `effectiveFrom <= at` and (`effectiveTo` is null or `> at`);
   *  - only rows that are global or owned by this user;
   *  - newest `effectiveFrom` first, `take: 10`;
   *  - then the tier tie-break in memory: any `userId !== null` row beats
   *    every global row, newest `effectiveFrom` wins inside a tier.
   *
   * The tie-break cannot be expressed as `orderBy: { userId: 'desc' }`:
   * Postgres sorts `NULLS FIRST` on `DESC`, which would rank the global row
   * first.
   */
  async resolvePricing(
    input: ResolvePricingInput,
  ): Promise<PricingSnapshot | null> {
    const provider = input.provider.trim().toLowerCase();
    const model = input.model.trim();
    const userId = input.userId ?? null;
    const currency = this.normalizeCurrency(input.currency);
    const at = input.at ?? new Date();

    const cacheKey = this.cacheKey(provider, model, userId, currency);
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.snapshot;
    }

    if (cached) {
      this.cache.delete(cacheKey);
    }

    const rows = await this.prisma.modelPricing.findMany({
      where: {
        isActive: true,
        provider,
        model,
        currency,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        AND: [{ OR: [{ userId }, { userId: null }] }],
      },
      orderBy: { effectiveFrom: 'desc' },
      take: CANDIDATE_LIMIT,
    });

    const selected = this.selectBest(rows);

    if (!selected) {
      // `null` is never cached: a price row seeded after boot must become
      // visible immediately rather than after one TTL.
      this.logger.debug(`No pricing for ${provider}/${model} (${currency})`);
      return null;
    }

    const snapshot = this.toSnapshot(selected);
    this.store(cacheKey, snapshot);
    return snapshot;
  }

  toSnapshot(row: ModelPricing): PricingSnapshot {
    return {
      pricingId: row.id,
      currency: row.currency,
      inputPricePerMillion: new Prisma.Decimal(row.inputPricePerMillion),
      outputPricePerMillion: new Prisma.Decimal(row.outputPricePerMillion),
    };
  }

  /** Test seam; also usable when prices are re-seeded at runtime. */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * In-memory tier selection. Rows arrive newest-first, but the ordering is
   * not trusted: a user row always wins over a global row, and the newest
   * `effectiveFrom` wins inside a tier.
   */
  private selectBest(rows: ModelPricing[]): ModelPricing | null {
    let best: ModelPricing | null = null;

    for (const row of rows) {
      if (best === null) {
        best = row;
        continue;
      }

      const rowIsUserScoped = row.userId !== null;
      const bestIsUserScoped = best.userId !== null;

      if (rowIsUserScoped !== bestIsUserScoped) {
        if (rowIsUserScoped) {
          best = row;
        }
        continue;
      }

      const rowTime = row.effectiveFrom.getTime();
      const bestTime = best.effectiveFrom.getTime();

      if (rowTime > bestTime) {
        best = row;
        continue;
      }

      // Identical timestamps only happen for global rows (Postgres treats
      // NULLs as distinct in the composite unique). Break the tie on the id
      // so the outcome is deterministic instead of query-order dependent.
      if (rowTime === bestTime && row.id < best.id) {
        best = row;
      }
    }

    return best;
  }

  private cacheKey(
    provider: string,
    model: string,
    userId: string | null,
    currency: string,
  ): string {
    return `${provider}:${model}:${userId ?? '*'}:${currency}`;
  }

  private store(key: string, snapshot: PricingSnapshot): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      this.evict();
    }

    this.cache.set(key, {
      snapshot,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  private evict(): void {
    const now = Date.now();

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }

    // Still full: drop insertion-ordered entries until there is room.
    while (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();

      if (oldest.done) {
        return;
      }

      this.cache.delete(oldest.value);
    }
  }

  private normalizeCurrency(currency?: string): string {
    const trimmed = currency?.trim();

    if (!trimmed) {
      return DEFAULT_CURRENCY;
    }

    return trimmed.toUpperCase();
  }
}
