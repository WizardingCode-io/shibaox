import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@wizardingcode/shibaox-core': fileURLToPath(
        new URL('../core/src/index.ts', import.meta.url),
      ),
      '@wizardingcode/shibaox-schemas': fileURLToPath(
        new URL('../schemas/src/index.ts', import.meta.url),
      ),
      '@wizardingcode/shibaox-daemon': fileURLToPath(
        new URL('../daemon/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 15_000 },
});
