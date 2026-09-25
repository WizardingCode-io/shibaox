import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shibaox/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@shibaox/persistence-sqlite': fileURLToPath(
        new URL('../../packages/persistence-sqlite/src/index.ts', import.meta.url),
      ),
      '@shibaox/schemas': fileURLToPath(
        new URL('../../packages/schemas/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 15_000 },
});
