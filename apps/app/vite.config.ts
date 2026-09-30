import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const src = (rel: string) => fileURLToPath(new URL(`../../packages/${rel}`, import.meta.url));

export default defineConfig({
  // the daemon and the CLI bridge serve the app under /app
  base: '/app/',
  plugins: [react()],
  // the vendored design system (tokens, bundle, fonts, logos) ships as-is next to the app
  publicDir: 'vendor',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  resolve: {
    alias: {
      '@wizardingcode/shibaox-view': src('view/src/index.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 15_000,
  },
});
