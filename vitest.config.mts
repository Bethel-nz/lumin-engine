import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: ['verbose'],
    setupFiles: ['./src/lib/test-utils.ts'],
    exclude: ['src/db/schema/**/*.ts'],
    isolate: true,  // Run tests in isolation
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: true,
      },
    },
  },
  resolve: {
    alias: {
      '@chronark/zod-bird': path.resolve(__dirname, 'src/__mocks__/@chronark/zod-bird.ts'),
    },
  },
}); 