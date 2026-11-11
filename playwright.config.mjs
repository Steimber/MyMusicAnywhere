import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: {
    timeout: 15000
  },
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3199',
    headless: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required']
    }
  }
});
