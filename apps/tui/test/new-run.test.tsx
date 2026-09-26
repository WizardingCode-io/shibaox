import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SubmitRequest, scaffoldOrg } from '@shibaox/daemon';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { NewRunForm } from '../src/components/NewRunForm.js';
import { loadPrefs, savePrefs } from '../src/prefs.js';

const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5));
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tui-form-'));
  dirs.push(dir);
  scaffoldOrg(dir);
  const home = join(dir, 'home');
  return { dir, home };
}

/** Types a string then presses enter. */
const type = (stdin: { write: (s: string) => void }, s: string) => {
  for (const ch of s) stdin.write(ch);
};

describe('NewRunForm', () => {
  it('defaults org to ./org in the cwd, lists its workflows and submits the fields', async () => {
    const { dir, home } = setup();
    const submitted: SubmitRequest[] = [];
    const { lastFrame, stdin, unmount } = render(
      <NewRunForm
        cwd={dir}
        home={home}
        env={{}}
        debounceMs={0}
        onSubmit={async (req) => {
          submitted.push(req);
          return 'run-1';
        }}
        onCancel={() => {}}
        onDone={() => {}}
      />,
    );
    await flush();
    expect(lastFrame()).toContain(join(dir, 'org'));
    expect(lastFrame()).toContain('hello-feature');
    stdin.write('\t'); // → project
    stdin.write('\t'); // → workflow
    stdin.write('\t'); // → input
    type(stdin, 'add /health');
    await flush();
    stdin.write('\r');
    await flush();
    expect(submitted).toEqual([
      {
        orgRoot: join(dir, 'org'),
        project: dir,
        workflow: 'hello-feature',
        input: 'add /health',
        adapter: 'mock',
        workspace: undefined,
        budgetUsd: undefined,
      },
    ]);
    expect(loadPrefs(home)).toMatchObject({
      lastOrg: join(dir, 'org'),
      lastProject: dir,
      lastAdapter: 'mock',
    });
    unmount();
  });

  it('an invalid org shows the load error and blocks submit', async () => {
    const { dir, home } = setup();
    const submitted: SubmitRequest[] = [];
    const { lastFrame, stdin, unmount } = render(
      <NewRunForm
        cwd={dir}
        home={home}
        env={{}}
        debounceMs={0}
        onSubmit={async (req) => {
          submitted.push(req);
          return 'x';
        }}
        onCancel={() => {}}
        onDone={() => {}}
      />,
    );
    await flush();
    // replace the org path with a missing one
    for (let i = 0; i < 200; i++) stdin.write('\u007f');
    type(stdin, join(dir, 'nope'));
    await flush(6);
    expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('org.yaml: file not found');
    stdin.write('\t');
    stdin.write('\t');
    stdin.write('\t');
    type(stdin, 'x');
    stdin.write('\r');
    await flush();
    expect(submitted).toEqual([]);
    // fixing the path lists the workflows again
    stdin.write('\t'); // adapter
    stdin.write('\t'); // workspace
    stdin.write('\t'); // budget
    stdin.write('\t'); // back to org
    for (let i = 0; i < 200; i++) stdin.write('\u007f');
    type(stdin, join(dir, 'org'));
    await flush(6);
    expect(lastFrame()).toContain('hello-feature');
    expect(lastFrame()?.replace(/\s+/g, ' ')).not.toContain('file not found');
    unmount();
  });

  it('shows a daemon error in the footer and esc cancels', async () => {
    const { dir, home } = setup();
    let cancelled = false;
    const { lastFrame, stdin, unmount } = render(
      <NewRunForm
        cwd={dir}
        home={home}
        env={{}}
        debounceMs={0}
        onSubmit={async () => {
          throw new Error('workflow "x" is not defined');
        }}
        onCancel={() => {
          cancelled = true;
        }}
        onDone={() => {}}
      />,
    );
    await flush();
    stdin.write('\t');
    stdin.write('\t');
    stdin.write('\t');
    type(stdin, 'go');
    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain('workflow "x" is not defined');
    stdin.write('\u001b');
    await new Promise((r) => setTimeout(r, 80)); // a lone ESC settles after Ink's escape timeout
    expect(cancelled).toBe(true);
    unmount();
  });

  it('prefs survive a round-trip and a broken file reads as empty', () => {
    const { home } = setup();
    savePrefs(home, { lastOrg: '/o', lastAdapter: 'direct' });
    expect(loadPrefs(home)).toEqual({ lastOrg: '/o', lastAdapter: 'direct' });
    expect(JSON.parse(readFileSync(join(home, 'ui.json'), 'utf8'))).toEqual({
      lastOrg: '/o',
      lastAdapter: 'direct',
    });
    expect(loadPrefs(join(home, 'missing'))).toEqual({});
  });
});
