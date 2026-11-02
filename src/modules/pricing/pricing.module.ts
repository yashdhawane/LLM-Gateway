import { Module } from '@nestjs/common';
import { CostCalculator } from './cost-calculator';
import { PricingService } from './pricing.service';

@Module({
  providers: [PricingService, CostCalculator],
  exports: [PricingService, CostCalculator],
})
export class PricingModule {}
