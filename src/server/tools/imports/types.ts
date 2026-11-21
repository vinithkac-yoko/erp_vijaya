import { z } from 'zod';

/**
 * What an import is made of (milestone 16). The assistant READS a file and says what each table in it is and which column is
 * what (the Spec). Tested code then reads every row with that spec and works out the changes (the Plan). The model never writes
 * rows: it describes the layout, the code does the rows.
 */
export const KINDS = ['materials', 'parties', 'parts', 'bom'] as const;
export type Kind = (typeof KINDS)[number];

export const FIELDS: Record<Kind, { name: string; required?: boolean; help: string }[]> = {
  materials: [
    { name: 'name', required: true, help: 'the material name / description' },
    { name: 'itemCode', help: 'part number or item code' },
    { name: 'unit', help: 'unit of measure (kg, nos, mtr, ltr, roll, set)' },
    { name: 'quantity', help: 'quantity in stock now (goes on the opening count; may include the unit, like "20 kgs")' },
    { name: 'category', help: 'kind / group (CORE, WIRE …)' },
    { name: 'rack', help: 'rack' }, { name: 'shelf', help: 'shelf' },
    { name: 'minimumLevel', help: 'minimum level' },
    { name: 'stockType', help: 'STANDING (kept in stock) or PER_JOB (bought for each job)' },
    { name: 'hsnCode', help: 'HSN code' }, { name: 'gstRate', help: 'GST rate, a number like 18' }, { name: 'notes', help: 'remarks' },
  ],
  parties: [
    { name: 'name', required: true, help: 'business name' },
    { name: 'role', help: 'supplier, customer or both' },
    { name: 'gstin', help: 'GSTIN' }, { name: 'city', help: 'city' }, { name: 'state', help: 'state' }, { name: 'address', help: 'address' },
    { name: 'pincode', help: 'PIN code' }, { name: 'phone', help: 'phone' }, { name: 'email', help: 'email' },
  ],
  parts: [
    { name: 'customer', required: true, help: 'the customer who buys it' },
    { name: 'partNumber', required: true, help: 'the part number' },
    { name: 'description', required: true, help: 'what the part is' },
    { name: 'hsnCode', help: 'HSN code' },
  ],
  bom: [
    { name: 'partNumber', required: true, help: 'the part number the line belongs to' },
    { name: 'customer', help: 'the customer (needed only if two customers use the same part number)' },
    { name: 'material', required: true, help: 'the material used (its name, as in the materials list)' },
    { name: 'qtyPerPiece', required: true, help: 'quantity of that material for ONE piece' },
  ],
};

export const TableSpec = z.object({
  uploadId: z.string().min(1).max(64),
  sheet: z.string().max(80).optional(),
  kind: z.enum(KINDS),
  /** The row (1 = first) that holds the headings; data starts on the next row. 0 = there is no heading row. */
  headerRow: z.number().int().min(0).max(500).default(1),
  /** The last row to read (default: the end of the sheet). */
  lastRow: z.number().int().min(1).optional(),
  /** field → column letter (A, B … AA). */
  columns: z.record(z.string().regex(/^[A-Za-z]{1,2}$/, 'A column is a letter like C.')),
  /** field → one value for every row where the sheet has none (the unit of the whole list, the role of every party …). */
  defaults: z.record(z.string().max(120)).optional(),
  /** Categories that are kept in stock (the rest are bought for each job), when the sheet has a category but no stock type. */
  standingCategories: z.array(z.string().max(40)).max(20).optional(),
  skipRows: z.array(z.number().int().positive()).max(500).optional(),
});
export type TableSpec = z.infer<typeof TableSpec>;
export const Spec = z.object({ title: z.string().trim().min(1).max(100), tables: z.array(TableSpec).min(1).max(12) });
export type Spec = z.infer<typeof Spec>;

export type Area = 'materials' | 'parties' | 'parts' | 'boms' | 'quantities';
export interface Step {
  key: string;
  area: Area;
  tool: 'create_material' | 'update_material' | 'create_party' | 'update_party' | 'create_part' | 'update_part' | 'set_part_bom' | 'set_opening_quantities';
  /** In words the owner uses. */
  label: string;
  input: Record<string, unknown>;
  /** For a change to something that exists: what it was when the plan was made (apply refuses if it is different by then). */
  before?: Record<string, unknown>;
}
export interface Option { value: string; label: string }
export interface Question {
  key: string;
  text: string;
  /** Everything it is about, by the names shown to the owner (capped). */
  items: string[];
  itemCount: number;
  /** A few examples, one per line, in words: "Ferrite core: system A1, sheet B2". */
  examples: string[];
  options: Option[];
  suggested: string;
}
/** An answer: one choice for all, and the choice for particular items where it differs. */
export interface Answer { choice: string; perItem?: Record<string, string> }
export type Answers = Record<string, Answer>;
export interface Held { sheet: string; row: number; item: string; reason: string }
export interface Plan {
  steps: Step[];
  /** Questions with no answer yet. Nothing is applied while any is open. */
  questions: Question[];
  /** Rows left out, and why. */
  held: Held[];
  /** Things to know that are not questions (a unit the system keeps, a code that was not used). */
  notes: string[];
  /** The plan in short plain lines, for the owner. */
  lines: string[];
  counts: Record<string, number>;
}

/** What the planners know about the database (read once, then the planners are pure). */
export interface Snapshot {
  materials: { id: string; name: string; nameKey: string; itemCode: string | null; itemCodeKey: string | null; uom: string; category: string | null; rack: string | null; shelf: string | null; minimumLevel: number | null; stockType: string; hsnCode: string | null; gstRate: number | null; isActive: boolean }[];
  parties: { id: string; name: string; nameKey: string; gstin: string | null; city: string | null; state: string | null; addressLine: string | null; pincode: string | null; phone: string | null; email: string | null; isSupplier: boolean; isCustomer: boolean; isActive: boolean }[];
  parts: { id: string; customerId: string; customerName: string; partNumber: string; partKey: string; description: string; hsnCode: string | null; isActive: boolean; bom: { materialId: string; materialName: string; qtyPerPiece: number }[] }[];
  /** The opening count, if one exists. */
  count: { id: string; status: string; number: string; lines: Map<string, { countedQty: number | null }> } | null;
}

export interface Grid { uploadId: string; filename: string; sheet: string; rows: string[][] }
