import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: ['verbose'],
    setupFiles: ['./src/lib/test-utils.ts'],
    exclude: ['src/db/schema/**/*.ts'],
  },
}); 