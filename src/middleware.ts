import { NextResponse, type NextRequest } from 'next/server';
import { makeNonce, securityHeaders } from '@/lib/security-headers';

/** Sets the CSP (with a fresh nonce) and the other security headers on every response. */
export function middleware(request: NextRequest) {
  const nonce = makeNonce();
  const dev = process.env.NODE_ENV !== 'production';
  const https = request.headers.get('x-forwarded-proto') === 'https' || request.nextUrl.protocol === 'https:';
  const headers = securityHeaders({ nonce, dev, hsts: !dev && https });

  // Next reads the nonce from the request's CSP header and stamps it on its own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', headers['Content-Security-Policy'] as string);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}

export const config = {
  // Everything except static build assets and image files.
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico|icon.svg|icons/|sw.js).*)' }],
};
