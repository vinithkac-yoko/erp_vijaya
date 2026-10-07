import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runTool } from '@/server/tools';
import { makeJob, makeParty, prisma, resetDb, uid } from './helpers/db';
import { fails, ok, save, storekeeper } from './helpers/tools';

beforeEach(() => resetDb());
afterAll(() => prisma.$disconnect());

const supplier = (name: string, over: Record<string, unknown> = {}) => ({ name, role: 'SUPPLIER', ...over });
const rows = async (s: Awaited<ReturnType<typeof storekeeper>>, input: object = {}) => (await ok<{ rows: Record<string, unknown>[] }>(runTool(s, 'search_parties', input))).rows;

describe('create_party', () => {
  it('adds a supplier with the name, city and GSTIN in their own boxes (1.16)', async () => {
    const s = await storekeeper();
    const r = await ok<{ id: string; outcome: string }>(save(s, 'create_party', supplier('Sundaram Ferrites', { city: 'Chennai', gstin: '33aaacs1234k1z2', state: 'Tamil Nadu' })));
    expect(r.outcome).toBe('CREATED');
    const p = await prisma.party.findUniqueOrThrow({ where: { id: r.id } });
    expect(p).toMatchObject({ name: 'Sundaram Ferrites', nameKey: 'sundaramferrites', city: 'Chennai', gstin: '33AAACS1234K1Z2', isSupplier: true, isCustomer: false, code: 'PTY-0001' });
  });

  it('GSTIN is optional (1.17); a customer and a scrap buyer are customers (1.18, 1.19)', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', supplier('Chennai Copper Wires')));
    const c = await ok<{ id: string }>(save(s, 'create_party', { name: 'Murugan Metal Scrap', role: 'CUSTOMER' }));
    expect(await prisma.party.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ isCustomer: true, isSupplier: false });
  });

  it('a bad GSTIN is refused with the expected format, next to the GSTIN box (1.23)', async () => {
    const s = await storekeeper();
    const f = await fails(save(s, 'create_party', supplier('Ravi Insulation Traders', { gstin: '33ABC' })));
    expect(f).toMatchObject({ code: 'INVALID_GSTIN', field: 'gstin' });
    expect(f.message).toContain('33AAACS1234K1Z2');
    expect(await prisma.party.count()).toBe(0);
  });

  it('the same business under another spelling is already saved (1.20)', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', supplier('Sundaram Ferrites')));
    const f = await fails(save(s, 'create_party', supplier('M/s Sundaram Ferrites Pvt Ltd')));
    expect(f).toMatchObject({ code: 'PARTY_EXISTS', field: 'name' });
    expect(f.message).toBe('"Sundaram Ferrites" is already saved as supplier.');
    expect(await prisma.party.count()).toBe(1);
  });

  it('the same GSTIN under another name is refused', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', supplier('Sundaram Ferrites', { gstin: '33AAACS1234K1Z2' })));
    const f = await fails(save(s, 'create_party', supplier('Totally Different Name', { gstin: '33AAACS1234K1Z2' })));
    expect(f).toMatchObject({ code: 'PARTY_EXISTS', field: 'gstin' });
  });

  it('a similar name is a question, answered by the user (1.21)', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', supplier('Sundaram Ferrites', { city: 'Chennai' })));
    const f = await fails(save(s, 'create_party', supplier('Sundaram Ferrite')));
    expect(f).toMatchObject({ code: 'SIMILAR_PARTY_EXISTS', field: 'name' });
    expect(f.details).toEqual({ matches: [{ name: 'Sundaram Ferrites', city: 'Chennai', type: 'Supplier' }] });
    expect(await prisma.party.count()).toBe(1);
    await ok(save(s, 'create_party', supplier('Sundaram Ferrite', { confirmNotDuplicate: true })));
    expect(await prisma.party.count()).toBe(2);
  });

  it('an existing business in a new role gets the role, not a second entry (1.22)', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', { name: 'Ashok Transformers', role: 'CUSTOMER' }));
    const r = await ok<{ outcome: string }>(save(s, 'create_party', supplier('Ashok Transformers')));
    expect(r.outcome).toBe('TYPE_ADDED');
    expect(await prisma.party.count()).toBe(1);
    expect(await prisma.party.findFirstOrThrow()).toMatchObject({ isSupplier: true, isCustomer: true });
    expect((await fails(save(s, 'create_party', { name: 'Ashok Transformers', role: 'BOTH' }))).code).toBe('PARTY_EXISTS');
    const ev = await prisma.auditEvent.findMany({ where: { toolName: 'create_party' }, orderBy: { createdAt: 'asc' } });
    expect(ev.map((e) => e.action)).toEqual(['CREATE', 'UPDATE']);
  });

  it('checks PIN code and email next to their boxes', async () => {
    const s = await storekeeper();
    expect(await fails(save(s, 'create_party', supplier('A Co', { pincode: '60' })))).toMatchObject({ code: 'INVALID_PINCODE', field: 'pincode' });
    expect(await fails(save(s, 'create_party', supplier('A Co', { email: 'nope' })))).toMatchObject({ code: 'INVALID_EMAIL', field: 'email' });
  });

  it('offers the next step as chips only for forms that exist for this person', async () => {
    const s = await storekeeper();
    const tool = (await import('@/server/tools')).registry.get('create_party') as unknown as { followUps: (c: unknown, i: unknown, r: unknown) => Promise<{ chips: unknown[] }> };
    const sup = await tool.followUps({}, {}, { id: 'p1', name: 'Sundaram Ferrites', isSupplier: true, isCustomer: false });
    expect(sup.chips).toEqual([{ label: 'Raise a purchase order to Sundaram Ferrites', form: 'create_purchase_order', prefill: { supplierId: 'p1' } }]);
    const cus = await tool.followUps({}, {}, { id: 'p2', name: 'Ashok Transformers', isSupplier: false, isCustomer: true });
    expect(cus.chips).toEqual([{ label: 'Record a customer PO', form: 'create_customer_po', prefill: { customerName: 'Ashok Transformers' } }]);
    void s;
  });
});

describe('search_parties', () => {
  it('lists suppliers with city and GSTIN, and not the customers (1.24)', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', supplier('Sundaram Ferrites', { city: 'Chennai', gstin: '33AAACS1234K1Z2' })));
    await ok(save(s, 'create_party', supplier('Chennai Copper Wires')));
    await ok(save(s, 'create_party', { name: 'Ashok Transformers', role: 'CUSTOMER' }));
    const r = await rows(s, { role: 'SUPPLIER' });
    expect(r.map((x) => x.name)).toEqual(['Chennai Copper Wires', 'Sundaram Ferrites']);
    expect(r[1]).toMatchObject({ type: 'Supplier', city: 'Chennai', gstin: '33AAACS1234K1Z2' });
    expect(JSON.stringify(r)).not.toMatch(/PTY-\d/);
  });
  it('finds by a spelling slip, by "Pvt Ltd", and by GSTIN', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', supplier('Sundaram Ferrites', { gstin: '33AAACS1234K1Z2' })));
    for (const q of ['sundaram ferites', 'M/s Sundaram Ferrites Pvt Ltd', '33aaacs1234k1z2']) expect((await rows(s, { query: q })).map((x) => x.name)).toEqual(['Sundaram Ferrites']);
  });
  it('does not list a party that was stopped', async () => {
    const s = await storekeeper();
    const p = await ok<{ id: string }>(save(s, 'create_party', supplier('Old Supplier')));
    await ok(save(s, 'deactivate_party', { partyId: p.id }));
    expect(await rows(s)).toEqual([]);
  });
});

describe('update_party and deactivate_party', () => {
  it('changes details, adds a role, never removes one', async () => {
    const s = await storekeeper();
    const p = await ok<{ id: string }>(save(s, 'create_party', supplier('Sundaram Ferrites')));
    await ok(save(s, 'update_party', { partyId: p.id, city: 'Chennai', addRole: 'CUSTOMER', phone: '044-1234' }));
    expect(await prisma.party.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ city: 'Chennai', isSupplier: true, isCustomer: true, phone: '044-1234' });
    expect((await fails(save(s, 'update_party', { partyId: p.id }))).code).toBe('NOTHING_TO_CHANGE');
    expect((await fails(save(s, 'update_party', { partyId: p.id, gstin: 'bad' }))).code).toBe('INVALID_GSTIN');
  });
  it('a rename cannot collide with another business', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', supplier('Sundaram Ferrites')));
    const b = await ok<{ id: string }>(save(s, 'create_party', supplier('Chennai Copper Wires')));
    expect((await fails(save(s, 'update_party', { partyId: b.id, name: 'sundaram ferrites pvt ltd' }))).code).toBe('PARTY_EXISTS');
  });
  it('cannot be stopped while it has open work, and says which', async () => {
    const s = await storekeeper();
    const sup = await makeParty('supplier', { name: 'Busy Supplier' });
    await prisma.purchaseOrder.create({ data: { number: `PO-${uid()}`, supplierId: sup.id, poDate: new Date(), status: 'APPROVED' } });
    const f = await fails(save(s, 'deactivate_party', { partyId: sup.id }));
    expect(f).toMatchObject({ code: 'PARTY_IN_USE', field: 'partyId' });
    expect(f.message).toBe('"Busy Supplier" still has 1 open purchase order.');

    const cust = await makeParty('customer', { name: 'Busy Customer' });
    await makeJob({ customerId: cust.id });
    expect((await fails(save(s, 'deactivate_party', { partyId: cust.id }))).message).toBe('"Busy Customer" still has 1 open job.');
    await prisma.job.updateMany({ data: { status: 'CLOSED' } });
    await ok(save(s, 'deactivate_party', { partyId: cust.id }));
    expect((await prisma.party.findUniqueOrThrow({ where: { id: cust.id } })).isActive).toBe(false);
  });
});
