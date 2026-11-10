import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Security headers (CSP with a per-request nonce) are set in src/middleware.ts.
  experimental: {
    // Server Actions are protected by Next's built-in Origin check; keep bodies small.
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default config;
