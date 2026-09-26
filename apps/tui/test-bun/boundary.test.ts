import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/** The TUI must never load the daemon's native modules: it talks to the daemon over the socket only. */
test('the app entry does not load the daemon or better-sqlite3', async () => {
  const app = fileURLToPath(new URL('../src/app.tsx', import.meta.url));
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      `await import(${JSON.stringify(app)}); const keys = Object.keys(require.cache); console.log(JSON.stringify(keys.filter((k) => /better-sqlite3|persistence-sqlite|run-manager|adapter-claude-code/.test(k))));`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(err).not.toContain('error');
  expect(JSON.parse(out.trim().split('\n').at(-1) ?? '[]')).toEqual([]);
});
