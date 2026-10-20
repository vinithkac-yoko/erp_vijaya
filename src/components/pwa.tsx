'use client';

import { useEffect } from 'react';

/** Registers the service worker (production only). Test browsers are left alone so a cached file never hides a change under test. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator) || navigator.webdriver) return;
    const go = () => { void navigator.serviceWorker.register('/sw.js').catch(() => undefined); };
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
  }, []);
  return null;
}
