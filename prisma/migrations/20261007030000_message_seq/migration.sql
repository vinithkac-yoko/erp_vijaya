-- DropIndex
DROP INDEX "messages_conversationId_createdAt_idx";

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "seq" SERIAL NOT NULL;

-- CreateIndex
CREATE INDEX "messages_conversationId_seq_idx" ON "messages"("conversationId", "seq");

