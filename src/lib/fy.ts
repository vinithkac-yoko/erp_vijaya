/** Indian financial year (April–March), in India time. FY 2026-27 is "2627". */
const IST = 'Asia/Kolkata';

export function financialYear(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: 'numeric' }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const start = month >= 4 ? year : year - 1;
  const two = (n: number) => String(n % 100).padStart(2, '0');
  return two(start) + two(start + 1);
}

/** "JOB", "2627", 31 → "JOB-2627-0031". */
export function formatDocNumber(prefix: string, fy: string, n: number, padding = 4): string {
  return `${prefix}-${fy}-${String(n).padStart(padding, '0')}`;
}
