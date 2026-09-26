import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shibaox/core': src('core/src/index.ts'),
      '@shibaox/persistence-sqlite': src('persistence-sqlite/src/index.ts'),
      '@shibaox/schemas': src('schemas/src/index.ts'),
      '@shibaox/providers/testing': src('providers/src/testing/fake-openai.ts'),
      '@shibaox/providers': src('providers/src/index.ts'),
      '@shibaox/jev/testing': src('jev/src/testing/fake-jev.ts'),
      '@shibaox/jev': src('jev/src/index.ts'),
      '@shibaox/adapter-direct': src('adapter-direct/src/index.ts'),
      '@shibaox/adapter-claude-code/testing': src('adapter-claude-code/src/testing/fake-query.ts'),
      '@shibaox/adapter-claude-code': src('adapter-claude-code/src/index.ts'),
      '@shibaox/memory': src('memory/src/index.ts'),
      '@shibaox/workspace': src('workspace/src/index.ts'),
    },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 15_000 },
});
