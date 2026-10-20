import { pendingActions, runTool } from '../tools';
import type { ToolSession } from '../tools/types';

/**
 * Demo data (docs/VIJAYA prompt §7): a realistic month, built through the same tools the people use, so the ledger, the
 * audit trail and every rule are the real ones. Nothing here writes a table by hand. It runs only when DEMO_MODE is on.
 *
 * The story: the opening count; 11 parts by part number; 12 jobs for four customers (a customer's open PO with three releases, and a sample);
 * purchase orders including one over the limit that waits for the owner; receipts with one rejection and one rate jump;
 * issues, returns and a top-up; scrap in and out; and a monthly count with a few differences nobody could explain, so the
 * leak report has something to say.
 */
type Data = Record<string, unknown>;
interface People { owner: ToolSession; storekeeper: ToolSession }

const ist = (daysAgo = 0) => new Date(Date.now() + 330 * 60_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);

async function act(who: ToolSession, tool: string, input: Data): Promise<Data> {
  const form = await pendingActions.create(who, { tool, origin: 'LAUNCHER' });
  if (!form.ok) throw new Error(`demo: ${tool} would not open: ${form.message}`);
  const r = await runTool(who, tool, input, { confirmation: form.data.id });
  if (!r.ok) throw new Error(`demo: ${tool}: ${r.message}`);
  return (r.data ?? {}) as Data;
}
const read = async (who: ToolSession, tool: string, input: Data = {}) => {
  const r = await runTool(who, tool, input);
  if (!r.ok) throw new Error(`demo: ${tool}: ${r.message}`);
  return r.data as { rows: Data[] } & Data;
};

const MATERIALS = [
  { name: '22 SWG Copper Wire', uom: 'KG', qty: 145, rate: 812, invoice: 'CCW/2627/0388' },
  { name: 'Ferrite Core E-30', uom: 'NOS', qty: 18, rate: 65, min: 50, invoice: 'SF/2627/0390' },
  { name: 'Bobbin Type-B', uom: 'NOS', qty: 640, rate: 9, invoice: 'RIT/2627/0211' },
  { name: 'Insulation Tape', uom: 'MTR', qty: 820, rate: 3.1, invoice: 'RIT/2627/0212' },
  { name: 'Varnish', uom: 'LTR', qty: 38, rate: 340, invoice: 'RIT/2627/0198' },
  { name: 'Paint', uom: 'LTR', qty: 12, rate: 420, invoice: 'RIT/2627/0199' },
  { name: 'Thinner', uom: 'LTR', qty: 20, rate: 150, invoice: 'RIT/2627/0200' },
  { name: 'Stickers', uom: 'NOS', qty: 3000, rate: 0.5, invoice: 'RIT/2627/0201' },
  { name: 'Copper Scrap', uom: 'KG', qty: 0, rate: 0, scrap: true },
] as const;

export async function seedDemo({ owner, storekeeper: sk }: People): Promise<void> {
  const id = {} as Record<string, string>;

  // ── masters ──
  for (const m of MATERIALS) {
    const r = await act(sk, 'create_material', { name: m.name, uom: m.uom, stockType: 'min' in m ? 'STANDING' : 'PER_JOB', ...('min' in m ? { minimumLevel: m.min } : {}), ...('scrap' in m ? { isScrap: true } : {}) });
    id[m.name] = String(r.id);
  }
  for (const [name, role, city, extra] of [
    ['Sundaram Ferrites', 'SUPPLIER', 'Chennai', { gstin: '33AAACS1234K1Z2', state: 'Tamil Nadu' }], ['Chennai Copper Wires', 'SUPPLIER', 'Chennai', { state: 'Tamil Nadu' }], ['Ravi Insulation Traders', 'SUPPLIER', 'Coimbatore', { state: 'Tamil Nadu' }],
    ['Ashok Transformers', 'CUSTOMER', 'Chennai', {}], ['Brightline LED', 'CUSTOMER', 'Bengaluru', {}], ['Southern Railway', 'CUSTOMER', 'Chennai', {}], ['Murugan Metal Scrap', 'CUSTOMER', 'Chennai', {}],
  ] as const) {
    const r = await act(sk, 'create_party', { name, role, city, ...extra });
    id[name] = String(r.id);
  }

  // ── the opening count (go-live) ──
  await act(sk, 'start_stock_count', { countDate: ist(30), isOpening: true });
  const open = await read(sk, 'list_count_lines');
  const lines = (open.rows as { id: string; material: string }[]).map((r) => {
    const m = MATERIALS.find((x) => x.name === r.material);
    return m ? { stockCountLineId: r.id, countedQty: m.qty, ...(m.qty > 0 ? { unitRate: m.rate, sourceInvoiceNo: 'invoice' in m ? m.invoice : undefined } : {}) } : null;
  }).filter(Boolean);
  await act(sk, 'save_count_sheet', { stockCountId: (open.count as { id: string }).id, lines });
  await act(sk, 'submit_stock_count', {});
  await act(owner, 'approve_stock_count', {});

  // ── purchasing: copper and cores (receipts: one rejection, one rate jump) ──
  const wire = id['22 SWG Copper Wire']!, core = id['Ferrite Core E-30']!, bobbin = id['Bobbin Type-B']!, tape = id['Insulation Tape']!, varnish = id['Varnish']!;
  const supplier = (n: string) => id[n]!;
  const po1 = await act(sk, 'create_purchase_order', { supplierId: supplier('Chennai Copper Wires'), lines: [{ materialId: wire, quantity: 50, rate: 812 }] });   // ₹40,600: approved at once
  const po1line = (await read(sk, 'get_purchase_order', { purchaseOrderId: String(po1.id) }) as unknown as { lines: { id: string }[] }).lines[0]!;
  await act(sk, 'record_goods_receipt', { supplierId: supplier('Chennai Copper Wires'), purchaseOrderId: String(po1.id), receiptDate: ist(), supplierInvoiceNo: 'CCW/2627/0412', lines: [{ materialId: wire, purchaseOrderLineId: po1line.id, receivedQty: 50, rejectedQty: 3, rejectionReason: 'Damaged in transit', rate: 812 }] });
  await act(sk, 'record_goods_receipt', { supplierId: supplier('Chennai Copper Wires'), receiptDate: ist(), supplierInvoiceNo: 'CCW/2627/0431', lines: [{ materialId: wire, receivedQty: 40, rate: 860 }] });   // the rate jumps by more than 5%
  await act(sk, 'record_goods_receipt', { supplierId: supplier('Ravi Insulation Traders'), receiptDate: ist(), lines: [{ materialId: bobbin, receivedQty: 1012, rate: 9 }] });
  await act(sk, 'record_goods_receipt', { supplierId: supplier('Sundaram Ferrites'), receiptDate: ist(), supplierInvoiceNo: 'SF/2627/0455', lines: [{ materialId: core, receivedQty: 2500, rate: 65 }] });

  // ── parts: everything runs by part number ──
  const PARTS = {
    smps: ['Ashok Transformers', '90301030002', 'SMPS TXFR 12V 2A'], led: ['Brightline LED', '90302100101', 'LED DRIVER TXFR'], toroid: ['Ashok Transformers', '90302200415', 'TOROIDAL INDUCTOR'],
    relay1: ['Southern Railway', '90306700245', 'RELAY TXFR L8'], relay2: ['Southern Railway', '90306700244', 'RELAY TXFR L4 (NEW DESIGN)'], relay3: ['Southern Railway', '90306401921', 'RELAY TXFR L3'],
    ballast: ['Ashok Transformers', '90305601208', 'BALLAST TXFR L3'], led24: ['Brightline LED', '90308000101', 'LED DRIVER TXFR 24V'], signal: ['Southern Railway', '90316200017', 'SIGNAL TXFR L3'],
    inductor: ['Ashok Transformers', '90308200008', 'INDUCTOR NEW DESIGN'], choke: ['Brightline LED', '90308000201', 'DRIVER CHOKE'],
  } as const;
  const partId = {} as Record<keyof typeof PARTS, string>;
  for (const [k, [customer, partNumber, description]] of Object.entries(PARTS) as [keyof typeof PARTS, readonly [string, string, string]][]) {
    partId[k] = String((await act(sk, 'create_part', { customerId: supplier(customer), partNumber, description })).id);
  }

  // ── jobs (twelve, four customers) ──
  const job = async (part: keyof typeof PARTS, qty: number, bom: { m: string; per: number }[] | null, days: number, extra: Data = {}) => {
    const j = await act(sk, 'create_job', { partId: partId[part], quantity: qty, jobDate: ist(days), ...extra });
    if (bom) await act(sk, 'set_job_bom', { jobId: String(j.id), lines: bom.map((b) => ({ materialId: id[b.m]!, qtyPerPiece: b.per })) });
    return String(j.id);
  };
  const W = '22 SWG Copper Wire', C = 'Ferrite Core E-30', B = 'Bobbin Type-B', T = 'Insulation Tape', V = 'Varnish';
  const smps = [{ m: W, per: 0.0184 }, { m: C, per: 2 }, { m: B, per: 1 }, { m: T, per: 0.3 }, { m: V, per: 0.005 }];
  const j1 = await job('smps', 500, smps, 26);
  const j2 = await job('led', 1200, [{ m: W, per: 0.008 }, { m: T, per: 0.2 }], 24);
  const j3 = await job('toroid', 300, [{ m: W, per: 0.012 }, { m: T, per: 0.25 }], 22);
  // the railway's open PO lists the three parts; the owner types the rate they pay (the storekeeper never sees it)
  const railPo = await act(owner, 'create_customer_po', { customerName: 'Southern Railway', number: 'SRSW-OP-44', lines: [{ partId: partId.relay1, quantity: 450, rate: 96 }, { partId: partId.relay2, quantity: 150, rate: 112 }, { partId: partId.relay3, quantity: 100, rate: 84 }] });
  const j4 = await job('relay1', 200, [{ m: W, per: 0.025 }, { m: C, per: 1 }, { m: T, per: 0.1 }], 20, { customerPoId: String(railPo.id) });
  const j5 = await job('relay2', 150, [{ m: W, per: 0.03 }, { m: B, per: 1 }], 12, { customerPoId: String(railPo.id) });
  const j6 = await job('relay3', 100, [{ m: W, per: 0.02 }, { m: T, per: 0.15 }], 4, { customerPoId: String(railPo.id) });
  const sample = await job('led', 5, [{ m: W, per: 0.01 }, { m: T, per: 0.2 }], 25, { type: 'SAMPLE', parentJobId: j2 });
  const j8 = await job('ballast', 800, [{ m: W, per: 0.014 }, { m: B, per: 1 }, { m: V, per: 0.004 }], 10);
  const j9 = await job('led24', 600, [{ m: W, per: 0.009 }, { m: T, per: 0.2 }], 6);
  await job('signal', 250, [{ m: W, per: 0.02 }, { m: C, per: 2 }], 3);
  await job('inductor', 400, null, 2);
  await job('choke', 150, [{ m: W, per: 0.006 }], 1);

  // ── the floor: give out, take back, a top-up, close ──
  for (const j of [j1, j2, j3, sample]) await act(sk, 'issue_material', { jobId: j });
  await act(sk, 'return_material', { jobId: j1, lines: [{ materialId: wire, quantity: 0.8 }] });
  await act(sk, 'close_job', { jobId: j1 });
  await act(sk, 'return_material', { jobId: j2, lines: [{ materialId: tape, quantity: 20 }] });
  await act(sk, 'close_job', { jobId: j2 });
  await act(sk, 'close_job', { jobId: sample, nothingReturned: true });
  await act(sk, 'issue_material', { jobId: j4 });
  await act(sk, 'issue_material', { jobId: j4, lines: [{ materialId: wire, quantity: 2, topUp: true }] });   // 2% rework: a top-up
  await act(sk, 'return_material', { jobId: j4, lines: [{ materialId: wire, quantity: 1 }] });
  await act(sk, 'close_job', { jobId: j4 });
  await act(sk, 'issue_material', { jobId: j5 });
  await act(sk, 'issue_material', { jobId: j8 });
  await act(sk, 'return_material', { jobId: j8, lines: [{ materialId: varnish, quantity: 0.5 }] });
  void j3; void j6; void j9;

  // ── scrap: 1.2 and 0.6 kg collected, 1.5 kg sold ──
  const scrap = id['Copper Scrap']!;
  await act(sk, 'record_scrap_in', { materialId: scrap, quantity: 1.2, jobId: j1 });
  await act(sk, 'record_scrap_in', { materialId: scrap, quantity: 0.6, jobId: j2 });
  await act(sk, 'record_scrap_sale', { materialId: scrap, buyerId: id['Murugan Metal Scrap']!, quantity: 1.5, rate: 620, saleDate: ist() });

  // ── more purchasing: cores (over the limit, waiting for the owner) and tape (approved at once) ──
  await act(sk, 'create_purchase_order', { supplierId: supplier('Sundaram Ferrites'), lines: [{ materialId: core, quantity: 982, rate: 65 }] });
  const tapePo = await act(sk, 'create_purchase_order', { supplierId: supplier('Ravi Insulation Traders'), lines: [{ materialId: tape, quantity: 5000, rate: 3 }] });
  void tapePo;

  // ── a monthly count with a few differences nobody could explain ──
  await act(sk, 'start_stock_count', { countDate: ist() });
  const cnt = await read(sk, 'list_count_lines');
  const diffs: Record<string, { counted: number; reason: string }> = {
    'Bobbin Type-B': { counted: 612, reason: 'UNEXPLAINED' }, Varnish: { counted: 34, reason: 'UNEXPLAINED' }, [W]: { counted: 98.5, reason: 'MISSING' },
  };
  const rows = cnt.rows as { id: string; material: string; systemQty: number }[];
  await act(sk, 'save_count_sheet', {
    stockCountId: (cnt.count as { id: string }).id,
    lines: rows.map((r) => ({ stockCountLineId: r.id, countedQty: Math.max(0, diffs[r.material]?.counted ?? (r.material === 'Bobbin Type-B' ? 612 : r.systemQty)), ...(diffs[r.material] ? { reasonCode: diffs[r.material]!.reason } : {}) })),
  });
  await act(sk, 'submit_stock_count', {});
  await act(owner, 'approve_stock_count', {});
}
