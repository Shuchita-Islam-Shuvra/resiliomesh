import { defineConfig, devices } from '@playwright/test'

// E2E runs against a real Supabase project + backend.
//   E2E_BASE_URL   (default http://localhost:5173 — dev server is started automatically)
//   E2E_PASSWORD   shared password of the seeded demo accounts (scripts/seed_demo.py)
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /responsive|auth/ },
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000,
  },
})
