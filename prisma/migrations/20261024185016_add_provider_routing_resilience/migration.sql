-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "cooldownMs" INTEGER NOT NULL DEFAULT 30000,
ADD COLUMN     "fallbackModels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "maxRetries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "upstreamName" TEXT;
