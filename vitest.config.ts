import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'postgres',
          include: ['tests/postgres/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
