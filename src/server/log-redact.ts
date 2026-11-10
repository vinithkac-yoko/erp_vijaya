/**
 * Nothing secret reaches a log (docs/SAFETY.md T19). Every line the server prints passes through this first: API keys,
 * authorization and cookie headers, session and database secrets, and passwords inside JSON or connection strings. The
 * server also never logs request bodies or tool inputs on purpose; this is the net underneath.
 */
const HIDDEN = '[hidden]';
const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[hidden]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${HIDDEN}`],
  [/\b(authorization|cookie|set-cookie|x-api-key)(["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, `$1$2${HIDDEN}`],
  [/\b(ANTHROPIC_API_KEY|SESSION_SECRET|SMTP_URL|DATABASE_URL|SEED_[A-Z_]*PASSWORD|[A-Z_]*(?:SECRET|TOKEN|PASSWORD|API_KEY))(\s*[=:]\s*)\S+/g, `$1$2${HIDDEN}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, `$1${HIDDEN}@`],
  [/(["']?(?:pass(?:word)?|passwd|pwd|secret|token|api[_-]?key|hash|passwordHash)["']?\s*[:=]\s*)(["'])[^"']*\2/gi, `$1"${HIDDEN}"`],
  [/\bvijaya_session=[^;\s]+/g, `vijaya_session=${HIDDEN}`],
];

export function redactLine(text: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to as string);
  return out;
}

const asText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`;
  try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { return String(v); }
};

type Fn = (...a: unknown[]) => void;
/** Wraps console so everything printed is redacted first. Safe to call twice. */
export function protectConsole(c: Pick<Console, 'log' | 'info' | 'warn' | 'error'> = console): void {
  for (const k of ['log', 'info', 'warn', 'error'] as const) {
    const original = c[k].bind(c) as Fn;
    if ((c[k] as unknown as { __redacting?: boolean }).__redacting) continue;
    const wrapped: Fn = (...args) => original(...args.map((a) => (typeof a === 'string' ? redactLine(a) : a instanceof Error || (a && typeof a === 'object') ? redactLine(asText(a)) : a)));
    (wrapped as unknown as { __redacting: boolean }).__redacting = true;
    c[k] = wrapped as never;
  }
}
