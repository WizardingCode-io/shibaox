import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore } from '@wizardingcode/shibaox-persistence-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '../src/client.js';
import { Daemon } from '../src/daemon.js';
import { homePaths } from '../src/home.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function daemonWith(draft?: (prompt: string) => Promise<string>) {
  const dir = mkdtempSync(join(tmpdir(), 'routines-api-'));
  tmp.push(dir);
  scaffoldOrg(dir);
  const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
  const daemon = new Daemon({
    discovery: false,
    home,
    store: new SqliteEventStore(join(dir, 'home', 'events.db')),
    channels: [],
    env: {},
    log: () => {},
    version: '9.9.9',
    vault: join(dir, 'vault'),
    routineDraft: draft,
  });
  daemons.push(daemon);
  await daemon.start();
  return { dir, org: join(dir, 'org'), client: new DaemonClient(home.socket) };
}

describe('the routines API: edit, views, drafts', () => {
  it('PUT /routines/:id edits a routine; GET lists views with the next run and approvals', async () => {
    const { org, client, dir } = await daemonWith();
    const r = await client.addRoutine({
      trigger: { type: 'cron', cron: '0 9 * * 1' },
      orgRoot: org,
      project: dir,
      workflow: 'chat',
      input: 'Monday',
      approvals: 'auto',
      model: 'openai/gpt-5',
    });
    expect(r.approvals).toBe('auto');
    const u = await client.updateRoutine(r.id, {
      name: 'Weekly',
      approvals: 'inbox',
      description: 'd',
    });
    expect(u).toMatchObject({
      name: 'Weekly',
      approvals: 'inbox',
      description: 'd',
      model: 'openai/gpt-5',
    });
    await expect(
      client.updateRoutine(r.id, { trigger: { type: 'cron', cron: 'x' } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(client.updateRoutine('nope', { name: 'x' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(client.updateRoutine(r.id, { approvals: 'yes' as never })).rejects.toMatchObject({
      status: 400,
    });
    const [view] = await client.routines();
    expect(typeof view?.nextRunAt).toBe('string');
    expect(view?.lastRun).toBeUndefined();
    const manual = await client.addRoutine({
      trigger: { type: 'manual' },
      orgRoot: org,
      project: dir,
      workflow: 'chat',
      input: 'x',
    });
    expect((await client.routine(manual.id)).nextRunAt).toBeNull();
  });

  it('POST /routines/draft turns a sentence into a routine draft with the cheap model, never saving it', async () => {
    const prompts: string[] = [];
    const { org, client, dir } = await daemonWith(async (prompt) => {
      prompts.push(prompt);
      return 'Sure:\n```json\n{"name":"Daily briefing","description":"What changed yesterday","trigger":{"type":"cron","cron":"0 9 * * 1-5"},"workflow":"chat","input":"Summarise yesterday\'s commits, PRs and issues.","approvals":"inbox"}\n```';
    });
    const d = await client.draftRoutine({
      text: 'every weekday at 9 tell me what changed',
      orgRoot: org,
      project: dir,
    });
    expect(d).toMatchObject({
      name: 'Daily briefing',
      trigger: { type: 'cron', cron: '0 9 * * 1-5' },
      workflow: 'chat',
      approvals: 'inbox',
    });
    expect(d.words).toMatch(/weekday|Mon/i);
    expect(prompts[0]).toContain('every weekday at 9');
    expect(prompts[0]).toContain('chat'); // the org's workflows are offered
    expect(await client.routines()).toHaveLength(0);
    await expect(
      client.draftRoutine({ text: '', orgRoot: org, project: dir }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('a draft without a callable model is a clear 503; a draft the model got wrong is a 502', async () => {
    const none = await daemonWith();
    // tiers on a provider whose key is not in the vault: nothing can be called
    writeFileSync(
      join(none.org, 'models.yaml'),
      'providers: {}\ntiers: { strong: anthropic/claude-opus, cheap: anthropic/claude-haiku, decision: jev-latest }\nroles: {}\ngates: {}\n',
    );
    await expect(
      none.client.draftRoutine({ text: 'x', orgRoot: none.org, project: none.dir }),
    ).rejects.toMatchObject({ status: 503 });
    const bad = await daemonWith(async () => 'not json at all');
    await expect(
      bad.client.draftRoutine({ text: 'x', orgRoot: bad.org, project: bad.dir }),
    ).rejects.toMatchObject({ status: 502 });
  });
});
