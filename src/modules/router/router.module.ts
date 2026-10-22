import { Module } from '@nestjs/common';
import { RouterService } from './router.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [RouterService],
  exports: [RouterService],
})
export class RouterModule {}