-- Part numbers (client's paperwork, 2026-10-20): a part master per customer, its usual BOM, a customer order's lines, a job's part, and a material's own item code.
-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "partId" TEXT;

-- AlterTable
ALTER TABLE "materials" ADD COLUMN     "itemCode" TEXT,
ADD COLUMN     "itemCodeKey" TEXT;

-- CreateTable
CREATE TABLE "parts" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "partKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "hsnCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_bom_lines" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "qtyPerPiece" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "part_bom_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_po_lines" (
    "id" TEXT NOT NULL,
    "customerPoId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "rate" DECIMAL(18,2),
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_po_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parts_partKey_idx" ON "parts"("partKey");

-- CreateIndex
CREATE UNIQUE INDEX "parts_customerId_partKey_key" ON "parts"("customerId", "partKey");

-- CreateIndex
CREATE INDEX "part_bom_lines_materialId_idx" ON "part_bom_lines"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "part_bom_lines_partId_materialId_key" ON "part_bom_lines"("partId", "materialId");

-- CreateIndex
CREATE INDEX "customer_po_lines_partId_idx" ON "customer_po_lines"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_po_lines_customerPoId_partId_key" ON "customer_po_lines"("customerPoId", "partId");

-- CreateIndex
CREATE INDEX "jobs_partId_idx" ON "jobs"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "materials_itemCodeKey_key" ON "materials"("itemCodeKey");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts" ADD CONSTRAINT "parts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_bom_lines" ADD CONSTRAINT "part_bom_lines_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_bom_lines" ADD CONSTRAINT "part_bom_lines_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_po_lines" ADD CONSTRAINT "customer_po_lines_customerPoId_fkey" FOREIGN KEY ("customerPoId") REFERENCES "customer_pos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_po_lines" ADD CONSTRAINT "customer_po_lines_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
