import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

describe('middleware', () => {
  it('sets the CSP with frame-src about: and a fresh nonce on every response', () => {
    const a = middleware(new NextRequest('http://localhost/'));
    const b = middleware(new NextRequest('http://localhost/login'));
    const cspA = a.headers.get('content-security-policy') ?? '';
    const cspB = b.headers.get('content-security-policy') ?? '';
    expect(cspA).toContain('frame-src about:');
    expect(cspA).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(cspA).not.toBe(cspB);
    expect(a.headers.get('x-frame-options')).toBe('DENY');
    expect(a.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('hands the same nonce to Next on the request, so Next can stamp its own scripts', () => {
    const r = middleware(new NextRequest('http://localhost/'));
    const forwarded = r.headers.get('x-middleware-request-content-security-policy') ?? '';
    const nonce = r.headers.get('x-middleware-request-x-nonce') ?? '';
    expect(nonce.length).toBeGreaterThan(10);
    expect(forwarded).toContain(`'nonce-${nonce}'`);
  });
});
