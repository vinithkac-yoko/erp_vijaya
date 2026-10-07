import { defineConfig, devices } from '@playwright/test';
import { loadTestEnv } from './tests/helpers/env';

// The browser tests use the test database, never the dev one.
loadTestEnv();

const PORT = 3100;
const STUB_PORT = 3199;
const chromium = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const launchOptions = { executablePath: chromium, args: ['--no-sandbox'] };

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: [
    // A scripted stand-in for the Anthropic API (the app's real SDK talks to it).
    { command: 'tsx tests/stub-server.ts', url: `http://127.0.0.1:${STUB_PORT}/`, reuseExistingServer: false, timeout: 30_000, env: { ...(process.env as Record<string, string>), STUB_PORT: String(STUB_PORT) } },
    {
      command: `next start -p ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...(process.env as Record<string, string>), NODE_ENV: 'production', APP_URL: `http://localhost:${PORT}`,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB_PORT}`, ANTHROPIC_API_KEY: 'e2e-not-a-real-key', AGENT_MESSAGES_PER_MINUTE: '500', ANTHROPIC_REFUSAL_FALLBACK: 'true',
      },
    },
  ],
  projects: [
    // Storekeeper's office desktop, owner's Android phone (VIJAYA prompt §9).
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions } },
    { name: 'phone', use: { ...devices['Pixel 7'], launchOptions } },
  ],
});
