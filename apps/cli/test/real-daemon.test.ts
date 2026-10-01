import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon, homePaths, scaffoldOrg } from '@wizardingcode/shibaox-daemon';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Opt-in: a real Claude Code session (your `claude` login) pushes to a local bare remote
 * through the daemon's approval flow. Costs real subscription usage.
 *   SHIBAOX_REAL_TESTS=1 pnpm --filter shibaox exec vitest run test/real-daemon.test.ts
 */
const real = process.env.SHIBAOX_REAL_TESTS === '1';
const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));
const tmpDirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

describe.skipIf(!real)('real Claude Code approval flow through the daemon', () => {
  it('a git push reaches the inbox, is approved, and lands on the remote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'real-d-'));
    tmpDirs.push(dir);
    scaffoldOrg(dir);
    writeFileSync(
      join(dir, 'org/models.yaml'),
      'providers: {}\ntiers: { strong: anthropic-subscription/claude-sonnet-5, cheap: anthropic-subscription/claude-haiku-4-5, decision: jev-latest }\nroles: {}\ngates: {}\n',
    );
    writeFileSync(
      join(dir, 'org/workflows/push-it.yaml'),
      [
        'workflow: push-it',
        'team: engineering',
        'start: push',
        'nodes:',
        '  push: { type: task, role: backend, instruction: "Run exactly this command and nothing else: git push origin main. Then finish." }',
        '',
      ].join('\n'),
    );
    const project = join(dir, 'proj');
    cpSync(sample, project, { recursive: true });
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'add', '-A');
    git(
      project,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--no-gpg-sign',
      '-m',
      'init',
    );
    const bare = join(dir, 'bare.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
    git(project, 'remote', 'add', 'origin', bare);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const daemon = new Daemon({
      home,
      channels: [],
      log: (l) => console.log(l),
      version: '0.2.4',
    });
    daemons.push(daemon);
    await daemon.start();
    const { runId } = await daemon.runs.submit({
      orgRoot: join(dir, 'org'),
      project,
      workflow: 'push-it',
      input: 'push main',
      adapter: 'claude-code',
      workspace: 'inplace',
    });
    await vi.waitFor(
      async () => expect((await daemon.inbox.list()).some((i) => i.kind === 'approval')).toBe(true),
      { timeout: 180_000, interval: 1000 },
    );
    const [item] = (await daemon.inbox.list()).filter((i) => i.kind === 'approval');
    expect(item?.detail.program).toBe('git');
    expect(item?.prompt).toContain('git push');
    await daemon.inbox.answer(item?.id ?? '', { approved: true, via: 'cli' });
    await vi.waitFor(
      async () => expect((await daemon.runs.state(runId)).status).toBe('completed'),
      {
        timeout: 180_000,
        interval: 1000,
      },
    );
    expect(git(dir, '--git-dir', bare, 'log', '--oneline')).toContain('init');
    const apiKey = daemon.runs
      .runtimeEvents(runId)
      .find((e) => e.event.type === 'text' && e.event.text.startsWith('claude-code ready:'));
    expect(apiKey && 'text' in apiKey.event ? apiKey.event.text : '').not.toContain(
      'apiKeySource=ANTHROPIC_API_KEY',
    );
  }, 400_000);
});
