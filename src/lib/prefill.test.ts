import { describe, it, expect } from 'vitest';
import { sanitizePrefill } from './prefill';
import { TOOLS } from './catalog';

// Ported from reference/artifacts/artifacts.test.ts (the kit keeps its own copy).
describe('prefill sanitiser', () => {
  it('drops rates, unknown fields and oversize values from agent and artifact', () => {
    for (const origin of ['agent', 'artifact'] as const) {
      const r = sanitizePrefill('create_purchase_order', { supplierName: 'Acme', rate: 5, evil: 1, expectedDate: 'x'.repeat(500), lines: [{ materialId: 'm1', quantity: 3, rate: 99, junk: 1 }] }, origin);
      expect(r.input).toEqual({ supplierName: 'Acme', lines: [{ materialId: 'm1', quantity: 3 }] });
      expect(r.dropped).toEqual(expect.arrayContaining(['rate', 'evil', 'expectedDate', 'lines[0].rate', 'lines[0].junk']));
      expect(r.assisted).toBe(true);
    }
  });
  it('drops the count rate and GRN rate', () => {
    expect(sanitizePrefill('submit_count_line', { stockCountLineId: 'l', unitRate: 4 }, 'agent').input).toEqual({ stockCountLineId: 'l' });
    expect(sanitizePrefill('record_goods_receipt', { supplierId: 's', lines: [{ materialId: 'm', receivedQty: 1, acceptedQty: 1, rate: 2 }] }, 'agent').input)
      .toEqual({ supplierId: 's', lines: [{ materialId: 'm', receivedQty: 1, acceptedQty: 1 }] });
  });
  it('caps lines at 50, rejects non-finite numbers and read tools', () => {
    const lines = Array.from({ length: 80 }, () => ({ materialId: 'm', quantity: 1 }));
    expect((sanitizePrefill('create_purchase_order', { lines }, 'agent').input.lines as unknown[]).length).toBe(50);
    expect(sanitizePrefill('issue_material', { jobId: 'j', lines: [{ materialId: 'm', quantity: Infinity }] }, 'agent').input).toEqual({ jobId: 'j', lines: [{ materialId: 'm' }] });
    expect(sanitizePrefill('list_jobs', { status: 'OPEN' }, 'agent').input).toEqual({});
  });
  it('launcher passes nothing; user input passes through', () => {
    expect(sanitizePrefill('create_job', { quantity: 5 }, 'launcher').input).toEqual({});
    expect(sanitizePrefill('create_job', { quantity: 5 }, 'user').input).toEqual({ quantity: 5 });
  });
  it('never leaves a rate behind for ANY write tool, whatever its name', () => {
    for (const t of Object.values(TOOLS).filter((x) => x.kind === 'write')) {
      const bad: Record<string, unknown> = { rate: 1, unitRate: 1, lines: [{ rate: 1, unitRate: 1 }] };
      expect(JSON.stringify(sanitizePrefill(t.name, bad, 'artifact').input)).not.toMatch(/rate/i);
    }
  });
  it('prefill from an artifact for an admin form is dropped entirely', () => {
    for (const tool of ['create_user', 'update_setting', 'approve_purchase_order', 'reverse_movement', 'share_artifact'])
      expect(sanitizePrefill(tool, { role: 'OWNER', key: 'x' }, 'artifact').input).toEqual({});
    expect(sanitizePrefill('create_user', { name: 'A' }, 'agent').input).toEqual({ name: 'A' }); // the agent may bring the form; the owner sees it
  });
});
