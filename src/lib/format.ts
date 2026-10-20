/** How numbers and dates read on screen (BUSINESS_FLOW §18): ₹1,15,791 · 142.6 kg · 12 Sep 2026 · 10:42. */

export const UOM_SHORT: Record<string, string> = { KG: 'kg', NOS: 'pcs', MTR: 'm', LTR: 'L', ROLL: 'roll', SET: 'set' };
export const UOM_LONG: Record<string, string> = { KG: 'kg', NOS: 'pieces', MTR: 'metres', LTR: 'litres', ROLL: 'rolls', SET: 'sets' };
export const UOM_CHOICES = [
  { value: 'NOS', label: 'Pieces (pcs)' },
  { value: 'KG', label: 'Kilograms (kg)' },
  { value: 'MTR', label: 'Metres (m)' },
  { value: 'LTR', label: 'Litres (L)' },
  { value: 'ROLL', label: 'Rolls' },
  { value: 'SET', label: 'Sets' },
];

/** Indian digit grouping: 1,15,791 and 12,34,567.50. */
export function groupIndian(n: number | string, decimals?: number): string {
  const num = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(num)) return '';
  const fixed = decimals === undefined ? String(Math.abs(num)) : Math.abs(num).toFixed(decimals);
  const [int = '0', frac] = fixed.split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return (num < 0 ? '-' : '') + grouped + (frac ? '.' + frac : '');
}

/** ₹1,15,791 for whole rupees, ₹1,15,791.20 when there are paise. */
export function inr(n: number | string): string {
  const num = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(num)) return '';
  const whole = Math.abs(num - Math.round(num)) < 0.005;
  return '₹' + groupIndian(num, whole ? 0 : 2);
}

/** A quantity, up to 4 decimals with trailing zeros dropped, and always its unit: "142.6 kg". */
export function qty(n: number | string, uom: string, long = false): string {
  const num = typeof n === 'string' ? Number(n) : n;
  const trimmed = Number(num.toFixed(4));
  return `${groupIndian(trimmed)} ${(long ? UOM_LONG : UOM_SHORT)[uom] ?? uom.toLowerCase()}`;
}

const IST = 'Asia/Kolkata';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Sep 2026". The month names are fixed here because locale data spells September "Sept". */
export function dateText(d: Date): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return `${get('day')} ${MONTHS[get('month') - 1]} ${get('year')}`;
}

/** "10:42", 24-hour, India time. */
export function timeText(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

/** A per-piece quantity as people say it: wire in grams, liquids in millilitres, the rest in their own unit. */
export function perPieceText(q: number, uom: string): string {
  if (uom === 'KG' && q < 1) return `${Number((q * 1000).toFixed(3))} g`;
  if (uom === 'LTR' && q < 1) return `${Number((q * 1000).toFixed(3))} ml`;
  return qty(q, uom);
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below100 = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`) as string;
const below1000 = (n: number) => `${n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' : ''}` : ''}${n % 100 ? below100(n % 100) : ''}`;

/** An amount in rupees the way a bill writes it, in lakhs and crores: "INR Seven Lakh Forty Four Thousand Nine Hundred Sixty Five and Sixty paise Only". */
export function rupeesInWords(amount: number): string {
  const paise = Math.round(Math.abs(amount) * 100);
  let r = Math.floor(paise / 100);
  const ps = paise % 100;
  const parts: string[] = [];
  const crore = Math.floor(r / 10_000_000); r %= 10_000_000;
  const lakh = Math.floor(r / 100_000); r %= 100_000;
  const thousand = Math.floor(r / 1000); r %= 1000;
  if (crore) parts.push(`${below1000(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (r) parts.push(below1000(r));
  const rupees = parts.join(' ') || 'Zero';
  return `INR ${rupees}${ps ? ` and ${below100(ps)} paise` : ''} Only`;
}
