-- CreateEnum
CREATE TYPE "Role" AS ENUM ('DEVELOPER', 'OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('USER', 'TEAM', 'ORG');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'DEVELOPER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT 'lg_',
    "name" TEXT NOT NULL DEFAULT 'default',
    "ownerId" TEXT NOT NULL,
    "ownerType" "OwnerType" NOT NULL DEFAULT 'USER',
    "userId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Model" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestLog" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "modelId" TEXT,
    "provider" TEXT,
    "statusCode" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "cost" DOUBLE PRECISION,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");

-- CreateIndex
CREATE INDEX "ApiKey_ownerId_ownerType_idx" ON "ApiKey"("ownerId", "ownerType");

-- CreateIndex
CREATE INDEX "ApiKey_prefix_idx" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Model_name_key" ON "Model"("name");

-- CreateIndex
CREATE UNIQUE INDEX "RequestLog_traceId_key" ON "RequestLog"("traceId");

-- CreateIndex
CREATE INDEX "RequestLog_traceId_idx" ON "RequestLog"("traceId");

-- CreateIndex
CREATE INDEX "RequestLog_userId_idx" ON "RequestLog"("userId");

-- CreateIndex
CREATE INDEX "RequestLog_apiKeyId_idx" ON "RequestLog"("apiKeyId");

-- CreateIndex
CREATE INDEX "RequestLog_createdAt_idx" ON "RequestLog"("createdAt");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;
