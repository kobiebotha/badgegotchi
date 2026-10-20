import { defineConfig } from '@playwright/test';

const production = process.env.BROWSER_BUILD === 'production';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: production
    ? ['**/production.spec.ts', '**/installer.spec.ts']
    : ['**/app.spec.ts', '**/installer.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: production ? './test-results/browser-production' : './test-results/browser',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: production
      ? 'npm run build && npm run preview -- --port 5173 --strictPort'
      : 'npm run dev -- --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      // Reserved .test hosts make this suite independent of local credentials.
      VITE_SUPABASE_URL: 'https://badgegotchi.supabase.test',
      VITE_SUPABASE_ANON_KEY: 'sb_publishable_browser_test_only',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_test_only',
      VITE_POWERSYNC_URL: 'https://sync.badgegotchi.test',
    },
  },
});
