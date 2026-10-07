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
