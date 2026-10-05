import { describe, it, expect } from 'vitest';
import { launcherFor, shortcutTool } from './launcher';
import { TOOLS } from './catalog';

// Ported from reference/artifacts/artifacts.test.ts (the kit keeps its own copy).
const flat = (l: ReturnType<typeof launcherFor>) => [...l.forms, ...l.moreForms, ...l.chips, ...l.moreChips];
const first = <T,>(a: T[]) => a[0] as T;

describe('launcher (top used)', () => {
  it('Count becomes Continue count and is pinned first when one is in progress', () => {
    const l = launcherFor('STOREKEEPER', { countInProgress: true, usage: { record_goods_receipt: 99 } });
    expect(first(l.forms).tool).toBe('start_stock_count');
    expect(first(l.forms).label).toBe('Continue count');
  });
  it('only offers tools the role may use, and each form button exists', () => {
    for (const role of ['STOREKEEPER', 'OWNER'] as const)
      for (const i of flat(launcherFor(role)))
        if (i.kind === 'form') {
          expect(TOOLS[i.tool]?.kind).toBe('write');
          expect(TOOLS[i.tool]?.roles).toContain(role);
        }
  });
  it('owner chips are not shown to the storekeeper, even if his usage says otherwise; no blank prompts', () => {
    const sk = flat(launcherFor('STOREKEEPER', { usage: { 'ask:Stock value': 500, 'ask:Waiting for me': 500 } }))
      .filter((i) => i.kind === 'ask').map((i) => i.label);
    expect(sk).not.toContain('Waiting for me');
    expect(sk).not.toContain('Stock value');
    for (const i of flat(launcherFor('OWNER'))) if (i.kind === 'ask') expect(i.prompt.length).toBeGreaterThan(5);
  });
  it('new users get the default order; usage reorders; ties keep default order', () => {
    expect(launcherFor('STOREKEEPER').forms.map((f) => f.tool)).toEqual(['record_goods_receipt', 'issue_material', 'return_material', 'start_stock_count']);
    const l = launcherFor('STOREKEEPER', { usage: { create_job: 7, create_purchase_order: 7, issue_material: 1 } });
    expect(l.forms.map((f) => f.tool)).toEqual(['create_purchase_order', 'create_job', 'issue_material', 'record_goods_receipt']);
  });
  it('caps the row and keeps the rest behind More; nothing is lost', () => {
    const l = launcherFor('OWNER');
    expect(l.forms.length).toBe(4);
    expect(l.moreForms.length).toBe(2);
    expect(l.forms.length + l.moreForms.length).toBe(6);
    expect(l.chips.length).toBeLessThanOrEqual(4);
  });
  it('junk usage values are ignored', () => {
    const l = launcherFor('STOREKEEPER', { usage: { create_job: NaN, issue_material: -5, return_material: 'x' as unknown as number } });
    expect(first(l.forms).tool).toBe('record_goods_receipt');
  });
  it('shortcuts work for every form the role may open, including ones behind More', () => {
    expect(shortcutTool('STOREKEEPER', 'r')).toBe('record_goods_receipt');
    expect(shortcutTool('STOREKEEPER', 'j')).toBe('create_job');
    expect(shortcutTool('STOREKEEPER', 'z')).toBeUndefined();
  });
});
