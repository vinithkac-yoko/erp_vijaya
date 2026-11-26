-- Milestone 13: where a material is kept and what kind of thing it is (from the store's own stock sheet). All optional.
ALTER TABLE "materials" ADD COLUMN "category" TEXT,
ADD COLUMN "rack" TEXT,
ADD COLUMN "shelf" TEXT;

CREATE INDEX "materials_rack_idx" ON "materials"("rack");
