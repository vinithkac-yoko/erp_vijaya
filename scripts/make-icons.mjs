// Draws the app icons (PNG) from the same coil mark as src/app/icon.svg. Run once: node scripts/make-icons.mjs
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const exe = process.env.CHROMIUM_PATH || chromium.executablePath();
const mark = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%"><rect width="64" height="64" fill="#1B2A38"/><g transform="translate(${pad} ${pad}) scale(${(64 - 2 * pad) / 64})"><path d="M6,34 Q14,12 22,34 T38,34 T54,34 T70,34" fill="none" stroke="#C98A4B" stroke-width="5" stroke-linecap="round"/></g></svg>`;
const jobs = [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-maskable-512.png', 512, 10], ['apple-touch-icon.png', 180, 0]];
mkdirSync('public/icons', { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
for (const [name, size, pad] of jobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">${mark(pad)}</body></html>`);
  writeFileSync(`public/icons/${name}`, await page.screenshot({ type: 'png' }));
  await page.close();
}
await browser.close();
console.log('icons written');
