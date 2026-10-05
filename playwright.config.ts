import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// The browser tests use the test database, never the dev one.
if (existsSync('.env.test')) process.loadEnvFile('.env.test');

const PORT = 3100;
const chromium = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const launchOptions = { executablePath: chromium, args: ['--no-sandbox'] };

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: `next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { ...process.env as Record<string, string>, NODE_ENV: 'production', APP_URL: `http://localhost:${PORT}` },
  },
  projects: [
    // Storekeeper's office desktop, owner's Android phone (VIJAYA prompt §9).
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions } },
    { name: 'phone', use: { ...devices['Pixel 7'], launchOptions } },
  ],
});
