import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index.ts is the stdio entry point; it is exercised by integration tests.
      exclude: ['src/index.ts'],
      reporter: ['text-summary', 'text', 'lcov'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
