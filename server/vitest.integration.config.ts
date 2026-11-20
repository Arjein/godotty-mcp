import { defineConfig } from 'vitest/config';

/** Integration tests run real Godot (GODOT_PATH or "godot" on PATH) against the demo project. */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
