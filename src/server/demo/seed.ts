import { pendingActions, runTool } from '../tools';
import type { ToolSession } from '../tools/types';

/**
 * Demo data (docs/VIJAYA prompt §7): a realistic month, built through the same tools the people use, so the ledger, the
 * audit trail and every rule are the real ones. Nothing here writes a table by hand. It runs only when DEMO_MODE is on.
 *
 * The story: the opening count; 12 jobs for four customers (a customer's open PO with three releases, and a sample);
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

  // ── jobs (twelve, four customers) ──
  const job = async (customer: string, qty: number, product: string, bom: { m: string; per: number }[] | null, days: number, extra: Data = {}) => {
    const j = await act(sk, 'create_job', { customerId: supplier(customer), productDescription: product, quantity: qty, jobDate: ist(days), ...extra });
    if (bom) await act(sk, 'set_job_bom', { jobId: String(j.id), lines: bom.map((b) => ({ materialId: id[b.m]!, qtyPerPiece: b.per })) });
    return String(j.id);
  };
  const W = '22 SWG Copper Wire', C = 'Ferrite Core E-30', B = 'Bobbin Type-B', T = 'Insulation Tape', V = 'Varnish';
  const smps = [{ m: W, per: 0.0184 }, { m: C, per: 2 }, { m: B, per: 1 }, { m: T, per: 0.3 }, { m: V, per: 0.005 }];
  const j1 = await job('Ashok Transformers', 500, 'SMPS transformer 12V 2A', smps, 26);
  const j2 = await job('Brightline LED', 1200, 'LED driver transformer', [{ m: W, per: 0.008 }, { m: T, per: 0.2 }], 24);
  const j3 = await job('Ashok Transformers', 300, 'Toroidal inductor', [{ m: W, per: 0.012 }, { m: T, per: 0.25 }], 22);
  const railPo = await act(sk, 'create_customer_po', { customerName: 'Southern Railway', number: 'SRSW-OP-44' });
  const j4 = await job('Southern Railway', 200, 'Relay transformer', [{ m: W, per: 0.025 }, { m: C, per: 1 }, { m: T, per: 0.1 }], 20, { customerPoId: String(railPo.id) });
  const j5 = await job('Southern Railway', 150, 'Relay transformer, new design', [{ m: W, per: 0.03 }, { m: B, per: 1 }], 12, { customerPoId: String(railPo.id) });
  const j6 = await job('Southern Railway', 100, 'Relay transformer, third release', [{ m: W, per: 0.02 }, { m: T, per: 0.15 }], 4, { customerPoId: String(railPo.id) });
  const sample = await job('Brightline LED', 5, 'LED driver sample', [{ m: W, per: 0.01 }, { m: T, per: 0.2 }], 25, { type: 'SAMPLE', parentJobId: j2 });
  const j8 = await job('Ashok Transformers', 800, 'Ballast transformer', [{ m: W, per: 0.014 }, { m: B, per: 1 }, { m: V, per: 0.004 }], 10);
  const j9 = await job('Brightline LED', 600, 'LED driver transformer, 24V', [{ m: W, per: 0.009 }, { m: T, per: 0.2 }], 6);
  await job('Southern Railway', 250, 'Signal transformer', [{ m: W, per: 0.02 }, { m: C, per: 2 }], 3);
  await job('Ashok Transformers', 400, 'Inductor, new design', null, 2);
  await job('Brightline LED', 150, 'Driver choke', [{ m: W, per: 0.006 }], 1);

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
