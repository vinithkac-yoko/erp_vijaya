import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { PlannedMaterial } from './stock-import';

/**
 * The store's opening stock as a plain list kept with the code (prisma/data/opening-stock.json): every material with its unit,
 * kind, rack, shelf and the quantity counted, and nothing else (no rates: the sheet has none). It is written by
 * `pnpm stock:import <sheet.xlsx> --write-data prisma/data/opening-stock.json` from the store's own sheet, after the review, and
 * it is read once, at start-up, by stock-startup.ts.
 */
const material = z.object({
  name: z.string().min(1).max(120),
  itemCode: z.string().max(40).nullable(),
  category: z.string().max(40).nullable(),
  uom: z.enum(['KG', 'NOS', 'MTR', 'LTR', 'ROLL', 'SET']),
  stockType: z.enum(['STANDING', 'PER_JOB']),
  minimumLevel: z.number().min(0).optional(),
  rack: z.string().max(20).nullable(),
  shelf: z.string().max(20).nullable(),
  notes: z.string().max(500).nullable(),
  counted: z.number().min(0).nullable(),
});
const file = z.object({ source: z.string(), madeOn: z.string(), materials: z.array(material).min(1).max(5000) });
export type OpeningStockFile = z.infer<typeof file>;

export const OPENING_STOCK_PATH = 'prisma/data/opening-stock.json';

export function toFile(materials: PlannedMaterial[], source: string, madeOn: string): OpeningStockFile {
  return file.parse({ source, madeOn, materials: materials.map(({ name, itemCode, category, uom, stockType, minimumLevel, rack, shelf, notes, counted }) => ({ name, itemCode, category, uom, stockType, ...(minimumLevel !== undefined ? { minimumLevel } : {}), rack, shelf, notes, counted })) });
}

/** The materials in the file, ready for applyStockPlan. A file that does not match the shape above is an error, never half-loaded. */
export function readOpeningStock(path: string): { file: OpeningStockFile; materials: PlannedMaterial[] } {
  const parsed = file.parse(JSON.parse(readFileSync(path, 'utf8')));
  return { file: parsed, materials: parsed.materials.map((m) => ({ ...m, lines: [], flags: [] })) };
}
