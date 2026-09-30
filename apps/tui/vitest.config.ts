import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@wizardingcode/shibaox-core': src('core/src/index.ts'),
      '@wizardingcode/shibaox-daemon/client': src('daemon/src/client.ts'),
      '@wizardingcode/shibaox-daemon': src('daemon/src/index.ts'),
      '@wizardingcode/shibaox-persistence-sqlite': src('persistence-sqlite/src/index.ts'),
      '@wizardingcode/shibaox-schemas': src('schemas/src/index.ts'),
      '@wizardingcode/shibaox-view': src('view/src/index.ts'),
      '@wizardingcode/shibaox-providers/testing': src('providers/src/testing/fake-openai.ts'),
      '@wizardingcode/shibaox-providers': src('providers/src/index.ts'),
      '@wizardingcode/shibaox-jev/testing': src('jev/src/testing/fake-jev.ts'),
      '@wizardingcode/shibaox-jev': src('jev/src/index.ts'),
      '@wizardingcode/shibaox-adapter-direct': src('adapter-direct/src/index.ts'),
      '@wizardingcode/shibaox-adapter-claude-code/testing': src(
        'adapter-claude-code/src/testing/fake-query.ts',
      ),
      '@wizardingcode/shibaox-adapter-claude-code': src('adapter-claude-code/src/index.ts'),
      '@wizardingcode/shibaox-memory': src('memory/src/index.ts'),
      '@wizardingcode/shibaox-workspace': src('workspace/src/index.ts'),
    },
  },
  test: { include: ['test-vitest/**/*.test.ts'], testTimeout: 20_000 },
});
