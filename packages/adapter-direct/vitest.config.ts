import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shibaox/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@shibaox/schemas': fileURLToPath(new URL('../schemas/src/index.ts', import.meta.url)),
      '@shibaox/providers/testing': fileURLToPath(
        new URL('../providers/src/testing/fake-openai.ts', import.meta.url),
      ),
      '@shibaox/providers': fileURLToPath(new URL('../providers/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 15_000 },
});
