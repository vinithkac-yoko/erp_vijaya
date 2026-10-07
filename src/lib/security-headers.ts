/**
 * Response headers for every page (docs/SAFETY.md, docs/ARTIFACTS.md §12).
 *
 * `frame-src about:` is MANDATORY: artifacts run in a srcdoc iframe, and without it a hostile artifact could
 * navigate itself to https://stranger/?data=… and leak what it read. Do not loosen it, and do not add hosts
 * to any source list — an allowed host is an exfiltration channel.
 */
export interface HeaderOptions {
  nonce: string;
  /** Next.js dev mode needs eval for React refresh. Never true in production. */
  dev?: boolean;
  /** Send HSTS (production, over https). */
  hsts?: boolean;
}

export function buildCsp({ nonce, dev = false }: HeaderOptions): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // The nonce lets our own scripts run; 'strict-dynamic' lets them load their chunks. A script an artifact creates later has no nonce.
    'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    // Tailwind and React write inline style attributes.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'media-src': ["'none'"],
    'object-src': ["'none'"],
    'worker-src': ["'self'"],
    // The artifact host's srcdoc frames are about:srcdoc. Nothing else may be framed or navigated to.
    'frame-src': ['about:'],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'base-uri': ["'self'"],
    'manifest-src': ["'self'"],
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

export function securityHeaders(opts: HeaderOptions): Record<string, string> {
  return {
    'Content-Security-Policy': buildCsp(opts),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-DNS-Prefetch-Control': 'off',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(opts.hsts ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

/** 128-bit random nonce, base64. Edge-runtime safe (Web Crypto only). */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
