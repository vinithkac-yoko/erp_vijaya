import { db } from '../../db';
import type { Db } from '../types';

/**
 * What reading PDFs and photos costs, and the monthly limit (milestone 16). Only those two cost anything: the model reads them
 * once and the result is kept. The owner's rule: a limit of ₹1,000 a month, changeable in Settings. The rupee figure is the
 * model's dollar price turned into rupees at the rate in Settings; the dollar price is a safe round-up (override with
 * UPLOAD_PRICE_USD_IN / UPLOAD_PRICE_USD_OUT, per million tokens).
 */
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const price = () => ({ in: num(process.env.UPLOAD_PRICE_USD_IN, 5), out: num(process.env.UPLOAD_PRICE_USD_OUT, 25) });

const IST_MS = 5.5 * 3600_000;
/** The start of this calendar month in India, as a moment. */
export function startOfIndiaMonth(now: Date): Date {
  const ist = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_MS);
}

async function setting(client: Db, key: string, fallback: number): Promise<number> {
  const row = await client.setting.findUnique({ where: { key } });
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 && row ? n : fallback;
}

export const costInr = (usdToInr: number, tokens: { input: number; output: number }) => ((tokens.input * price().in + tokens.output * price().out) / 1e6) * usdToInr;

export interface SpendStatus { spent: number; cap: number; left: number; usdToInr: number }
export async function spendStatus(now: Date, client: Db = db): Promise<SpendStatus> {
  const [cap, usdToInr] = [await setting(client, 'uploads.monthly_cap_inr', 1000), await setting(client, 'uploads.usd_to_inr', 90)];
  const sum = await client.aiSpend.aggregate({ where: { createdAt: { gte: startOfIndiaMonth(now) } }, _sum: { costInr: true } });
  const spent = Number(sum._sum.costInr ?? 0);
  return { spent, cap, left: Math.max(0, cap - spent), usdToInr };
}

export async function recordSpend(o: { userId: string; uploadId: string | null; purpose: string; model: string; usage: { input: number; output: number }; usdToInr: number; now: Date }, client: Db = db): Promise<number> {
  const rupees = costInr(o.usdToInr, o.usage);
  await client.aiSpend.create({ data: { userId: o.userId, uploadId: o.uploadId, purpose: o.purpose, model: o.model, inputTokens: o.usage.input, outputTokens: o.usage.output, costInr: rupees.toFixed(4), createdAt: o.now } });
  return rupees;
}

/** A rough cost of reading a file before it is read, so a file that would go past the limit is refused first. */
export const estimateRead = (usdToInr: number, tokens: { input: number; output: number }) => costInr(usdToInr, tokens);

export const rupees = (n: number) => `₹${n >= 100 ? Math.round(n).toLocaleString('en-IN') : n.toFixed(2)}`;
