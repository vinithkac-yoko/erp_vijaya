-- Decisions (the owner's answers to docs/CLIENT_CONFIRMATIONS.md) and a cache of translations.
-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('OPEN', 'ANSWERED', 'NEEDS_CLIENT', 'LATER');

-- CreateTable
CREATE TABLE "decisions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "whatWeDid" TEXT NOT NULL,
    "why" TEXT,
    "options" JSONB NOT NULL,
    "firstPass" BOOLEAN NOT NULL DEFAULT false,
    "agreedByKasi" BOOLEAN NOT NULL DEFAULT false,
    "status" "DecisionStatus" NOT NULL DEFAULT 'OPEN',
    "answerChoice" TEXT,
    "answerNote" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answeredById" TEXT,
    "statusNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translations" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decisions_key_key" ON "decisions"("key");

-- CreateIndex
CREATE INDEX "decisions_status_firstPass_position_idx" ON "decisions"("status", "firstPass", "position");

-- CreateIndex
CREATE INDEX "decisions_answeredById_idx" ON "decisions"("answeredById");

-- CreateIndex
CREATE UNIQUE INDEX "translations_sourceKey_language_key" ON "translations"("sourceKey", "language");

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

