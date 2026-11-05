import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/sdk',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
});
