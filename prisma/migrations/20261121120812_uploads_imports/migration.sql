-- CreateEnum
CREATE TYPE "UploadKind" AS ENUM ('XLSX', 'CSV', 'DOCX', 'TXT', 'PDF', 'IMAGE');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('DRAFT', 'APPLIED', 'DISCARDED', 'UNDONE');

-- CreateTable
CREATE TABLE "uploads" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "kind" "UploadKind" NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA,
    "content" JSONB,
    "readError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_drafts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "title" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'DRAFT',
    "spec" JSONB NOT NULL,
    "plan" JSONB NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "uploadIds" TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 1,
    "result" JSONB,
    "appliedAt" TIMESTAMP(3),
    "appliedAuditId" TEXT,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_spend" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "uploadId" TEXT,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costInr" DECIMAL(10,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_spend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "uploads_userId_createdAt_idx" ON "uploads"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "uploads_expiresAt_idx" ON "uploads"("expiresAt");

-- CreateIndex
CREATE INDEX "import_drafts_userId_createdAt_idx" ON "import_drafts"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_spend_userId_createdAt_idx" ON "ai_spend"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_spend_createdAt_idx" ON "ai_spend"("createdAt");

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_drafts" ADD CONSTRAINT "import_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_spend" ADD CONSTRAINT "ai_spend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
