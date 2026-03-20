import { defineConfig } from 'vitest/config';
import path from 'path';

const root = path.resolve(__dirname, '../..');

export default defineConfig({
  root,
  test: {
    root,
    include: ['tests/vitest/**/*.test.ts'],
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'istanbul',
      reporter: ['json'],
    },
  },
});
