import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 240_000,
  expect: { timeout: 180_000 },
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', channel: 'chrome', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
});
