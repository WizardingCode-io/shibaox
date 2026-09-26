import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shibaox/core': src('core'),
      '@shibaox/schemas': src('schemas'),
      '@shibaox/persistence-sqlite': src('persistence-sqlite'),
    },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 20_000 },
});
