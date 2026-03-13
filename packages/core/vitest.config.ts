import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/index.ts',       // barrel re-exports
        'src/**/__tests__/**',   // test files
      ],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 90,
        lines: 95,
      },
    },
  },
});
