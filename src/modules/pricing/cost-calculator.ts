import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { sanitizeErrorMessage } from '../../common/errors/failure-classifier';
import { PricingService, type PricingSnapshot } from './pricing.service';

// Declared in `pricing.service.ts` and re-exported here so consumers can import
// both types from one place without creating a circular import.
export type { PricingSnapshot } from './pricing.service';

export interface CostInput {
  promptTokens?: number | null;
  completionTokens?: number | null;
  pricing: PricingSnapshot | null;
}

export interface CostBreakdown {
  pricingId: string;
  currency: string;
  inputCost: Prisma.Decimal | null;
  outputCost: Prisma.Decimal | null;
  totalCost: Prisma.Decimal | null;
}

export const TOKENS_PER_PRICE_UNIT = 1_000_000;
export const COST_SCALE = 10;

/**
 * Pure, DB-free money math. Exported so tests can exercise it without Prisma.
 *
 * Rules (§6.6):
 *  - `pricing === null` → `null` (unknown, never zero: zero means free);
 *  - per side `tokens / 1_000_000 × pricePerMillion`, rounded to 10 decimal
 *    places with ROUND_HALF_UP;
 *  - `totalCost` needs both token counts, otherwise `null`;
 *  - zero tokens is valid and yields `Decimal(0)`, serialised `"0"`.
 *
 * Multiplying before dividing keeps the intermediate value exact (dividing by
 * 1_000_000 is a pure decimal shift).
 */
export function calculateCost(input: CostInput): CostBreakdown | null {
  const { pricing } = input;

  if (!pricing) {
    return null;
  }

  const inputCost = sideCost(
    input.promptTokens,
    pricing.inputPricePerMillion,
  );
  const outputCost = sideCost(
    input.completionTokens,
    pricing.outputPricePerMillion,
  );

  const totalCost =
    inputCost !== null && outputCost !== null
      ? inputCost.plus(outputCost)
      : null;

  return {
    pricingId: pricing.pricingId,
    currency: pricing.currency,
    inputCost,
    outputCost,
    totalCost,
  };
}

function sideCost(
  tokens: number | null | undefined,
  pricePerMillion: Prisma.Decimal,
): Prisma.Decimal | null {
  if (tokens === null || tokens === undefined) {
    return null;
  }

  if (!Number.isFinite(tokens)) {
    return null;
  }

  return new Prisma.Decimal(tokens)
    .times(new Prisma.Decimal(pricePerMillion))
    .dividedBy(TOKENS_PER_PRICE_UNIT)
    .toDecimalPlaces(COST_SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

@Injectable()
export class CostCalculator {
  private readonly logger = new Logger(CostCalculator.name);

  constructor(private readonly pricing: PricingService) {}

  /**
   * TOTAL: every failure (DB down, bad decimal, unexpected error) becomes
   * `null`. Pricing runs on the post-success path, so throwing here would
   * turn a paid successful completion into a 500.
   */
  async calculate(input: {
    provider: string;
    model: string;
    userId?: string | null;
    at?: Date;
    promptTokens?: number | null;
    completionTokens?: number | null;
  }): Promise<CostBreakdown | null> {
    try {
      const pricing = await this.pricing.resolvePricing({
        provider: input.provider,
        model: input.model,
        userId: input.userId,
        at: input.at,
      });

      return calculateCost({
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        pricing,
      });
    } catch (error) {
      // Still total, but never silent: an unpriceable request is observable.
      this.logger.warn(
        `cost calculation failed for ${input.provider}/${input.model}: ${
          sanitizeErrorMessage(error) ?? 'unknown'
        }`,
      );
      return null;
    }
  }
}
