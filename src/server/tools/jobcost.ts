import type { Db } from './types';

/**
 * What has gone out to a job and come back, from the ledger itself (never from a counter that could drift). Issues and
 * reversals of issues and returns all carry the job; scrap collected "from" a job is not material used by it.
 * Out is positive, in is negative: what the job is holding is OUT − IN.
 */
const JOB_TYPES = ['ISSUE', 'RETURN', 'REVERSAL'] as const;

export interface JobMaterialTotal { materialId: string; net: number; value: number; issued: number; returned: number }

export async function jobTotals(db: Db, jobId: string): Promise<Map<string, JobMaterialTotal>> {
  const rows = await db.stockMovement.findMany({ where: { jobId, type: { in: [...JOB_TYPES] } }, select: { materialId: true, type: true, direction: true, quantity: true, value: true, reasonCode: true } });
  const out = new Map<string, JobMaterialTotal>();
  for (const m of rows) {
    const t = out.get(m.materialId) ?? { materialId: m.materialId, net: 0, value: 0, issued: 0, returned: 0 };
    const sign = m.direction === 'OUT' ? 1 : -1;
    t.net += sign * Number(m.quantity);
    t.value += sign * Number(m.value);
    if (m.type === 'ISSUE') t.issued += Number(m.quantity);
    if (m.type === 'RETURN') t.returned += Number(m.quantity);
    out.set(m.materialId, t);
  }
  for (const t of out.values()) { t.net = Math.round(t.net * 10_000) / 10_000; t.value = Math.round(t.value * 100) / 100; }
  return out;
}

/** Material cost so far: value out less value back, to the paisa. */
export async function jobCost(db: Db, jobId: string): Promise<number> {
  const t = await jobTotals(db, jobId);
  return Math.round([...t.values()].reduce((s, x) => s + x.value, 0) * 100) / 100;
}
