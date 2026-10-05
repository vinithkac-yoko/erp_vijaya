import { describe, it, expect } from 'vitest';
import { buildCsp, makeNonce, securityHeaders } from './security-headers';

const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(name + ' '));

describe('Content-Security-Policy', () => {
  const csp = buildCsp({ nonce: 'abc123' });

  it('sends frame-src about: (SAFETY T6: without it a hostile artifact can navigate itself and leak data)', () => {
    expect(directive(csp, 'frame-src')).toBe('frame-src about:');
  });
  it('puts the nonce on scripts and does not allow inline or eval scripts in production', () => {
    const script = directive(csp, 'script-src') ?? '';
    expect(script).toContain("'nonce-abc123'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });
  it('allows eval only in dev', () => {
    expect(directive(buildCsp({ nonce: 'n', dev: true }), 'script-src')).toContain("'unsafe-eval'");
  });
  it('allows no outside hosts anywhere (an allowed host is an exfiltration channel)', () => {
    expect(csp).not.toMatch(/https?:/);
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
    expect(directive(csp, 'img-src')).toBe("img-src 'self' data: blob:");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
  });
});

describe('other security headers', () => {
  it('sets the standard set, and HSTS only when asked', () => {
    const h = securityHeaders({ nonce: 'n' });
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['X-DNS-Prefetch-Control']).toBe('off');
    expect(h['Permissions-Policy']).toContain('camera=()');
    expect(h['Strict-Transport-Security']).toBeUndefined();
    expect(securityHeaders({ nonce: 'n', hsts: true })['Strict-Transport-Security']).toContain('max-age=');
  });
  it('nonces are unique, base64, and 128 bits', () => {
    const seen = new Set(Array.from({ length: 50 }, makeNonce));
    expect(seen.size).toBe(50);
    for (const n of seen) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
