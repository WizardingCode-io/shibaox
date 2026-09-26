#!/usr/bin/env node
import { ADAPTER_IDS, type AdapterId, type GraphMode } from '@shibaox/daemon';
import { Command, InvalidArgumentError, Option } from 'commander';
import { connect } from './client.js';
import { daemonStart, daemonStatus, daemonStop } from './commands/daemon.js';
import { doctorCommand } from './commands/doctor.js';
import { followRun } from './commands/follow.js';
import { graphBuild, graphQuery, graphUpdate } from './commands/graph.js';
import { answerCommand, inboxCommand } from './commands/inbox.js';
import { initCommand } from './commands/init.js';
import { modelsCommand } from './commands/models.js';
import { providersListCommand, providersTestCommand } from './commands/providers.js';
import {
  cancelCommand,
  replayCommand,
  resumeCommand,
  runCommand,
  runsCommand,
} from './commands/run.js';
import { scheduleAdd, scheduleList, scheduleRemove, scheduleRun } from './commands/schedule.js';
import { worktreeList, worktreeRemove } from './commands/worktree.js';
import { makeOut } from './output.js';
import { CLI_VERSION } from './version.js';

function parseBudget(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be a positive number');
  return n;
}

const exitWith = (code: number) => {
  process.exitCode = code;
};
const graphOption = () =>
  new Option('--graph <mode>', 'use graphify-out/graph.json when it exists (never builds it)')
    .choices(['auto', 'off'])
    .default('auto');
const jsonOf = (cmd: Command): boolean => Boolean(cmd.optsWithGlobals().json);
const out = (cmd: Command) => makeOut(jsonOf(cmd));

const program = new Command()
  .name('shibaox')
  .description('Agent OS over coding runtimes')
  .version(CLI_VERSION)
  .option('--json', 'one JSON object per line instead of text');

program
  .command('init')
  .argument('[dir]', 'target directory', '.')
  .description('scaffold org/ and vault/')
  .action((dir: string) => initCommand(dir));
program
  .command('doctor')
  .description('check local prerequisites, the daemon and channels')
  .action(async () => exitWith(await doctorCommand()));

program
  .command('run')
  .argument('<workflow>')
  .description('submit a run to the daemon and follow it (Ctrl-C leaves it running)')
  .requiredOption('--org <dir>', 'org repo directory')
  .requiredOption('--project <path>', 'project workspace')
  .requiredOption('--input <text>', 'request / spec text')
  .addOption(
    new Option(
      '--adapter <id>',
      'runtime adapter (default: `adapter:` in org.yaml, else mock)',
    ).choices(ADAPTER_IDS),
  )
  .addOption(
    new Option(
      '--workspace <mode>',
      'where tasks run (default: worktree in a git repository, else inplace)',
    ).choices(['inplace', 'worktree']),
  )
  .addOption(graphOption())
  .option('--budget <usd>', 'budget in USD (default: org budgets.per_run_usd)', parseBudget)
  .option('--detach', 'submit and return without following')
  .action(async function (this: Command, workflow: string, o: Record<string, unknown>) {
    exitWith(
      await runCommand(
        workflow,
        {
          org: o.org as string,
          project: o.project as string,
          input: o.input as string,
          adapter: o.adapter as AdapterId | undefined,
          workspace: o.workspace as 'inplace' | 'worktree' | undefined,
          graph: o.graph as GraphMode | undefined,
          budget: o.budget as number | undefined,
          detach: Boolean(o.detach),
        },
        out(this),
      ),
    );
  });
program
  .command('follow')
  .argument('<runId>')
  .description('print a run as it progresses')
  .option('--since <n>', 'start after frame n', (v) => Number(v))
  .action(async function (this: Command, runId: string, o: { since?: number }) {
    const client = await connect();
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    exitWith(await followRun(client, runId, { since: o.since, signal: ac.signal }, out(this)));
  });
program
  .command('resume')
  .argument('<runId>')
  .description('continue a waiting, budget-paused or interrupted run')
  .option('--budget <usd>', 'new budget in USD (required to resume a budget pause)', parseBudget)
  .action(async function (this: Command, runId: string, o: { budget?: number }) {
    exitWith(await resumeCommand(runId, o, out(this)));
  });
program
  .command('cancel')
  .argument('<runId>')
  .description('cancel a run')
  .action(async function (this: Command, runId: string) {
    exitWith(await cancelCommand(runId, out(this)));
  });
program
  .command('runs')
  .description('list runs')
  .option('--status <status>', 'only runs in this status')
  .option('--org <dir>', 'only runs of this org')
  .action(async function (this: Command, o: { status?: string; org?: string }) {
    exitWith(await runsCommand(o, out(this)));
  });
program
  .command('replay')
  .argument('<runId>')
  .description('print the event log of a run (offline with --db)')
  .option('--db <path>', 'read this events database instead of asking the daemon')
  .action(async function (this: Command, runId: string, o: { db?: string }) {
    exitWith(await replayCommand(runId, o, out(this)));
  });

program
  .command('inbox')
  .description('what is waiting for you: human nodes and tool approvals')
  .action(async function (this: Command) {
    exitWith(await inboxCommand(out(this)));
  });
program
  .command('approve')
  .argument('<id>', 'an inbox id (human:<run>:<node> or approval:<id>)')
  .option('--note <text>')
  .action(async function (this: Command, id: string, o: { note?: string }) {
    exitWith(await answerCommand(id, true, o, out(this)));
  });
program
  .command('deny')
  .argument('<id>', 'an inbox id (human:<run>:<node> or approval:<id>)')
  .option('--note <text>')
  .action(async function (this: Command, id: string, o: { note?: string }) {
    exitWith(await answerCommand(id, false, o, out(this)));
  });

const schedule = program.command('schedule').description('cron schedules that submit runs');
schedule
  .command('add')
  .argument('<cron>', 'cron expression, e.g. "0 9 * * 1-5"')
  .argument('<workflow>')
  .requiredOption('--org <dir>')
  .requiredOption('--project <path>')
  .option('--input <text>')
  .addOption(new Option('--adapter <id>').choices(ADAPTER_IDS))
  .option('--budget <usd>', 'budget in USD', parseBudget)
  .action(async function (
    this: Command,
    cron: string,
    workflow: string,
    o: Record<string, unknown>,
  ) {
    exitWith(
      await scheduleAdd(
        cron,
        workflow,
        {
          org: o.org as string,
          project: o.project as string,
          input: o.input as string | undefined,
          adapter: o.adapter as string | undefined,
          budget: o.budget as number | undefined,
        },
        out(this),
      ),
    );
  });
schedule.command('list').action(async function (this: Command) {
  exitWith(await scheduleList(out(this)));
});
schedule
  .command('rm')
  .argument('<id>')
  .action(async function (this: Command, id: string) {
    exitWith(await scheduleRemove(id, out(this)));
  });
schedule
  .command('run')
  .argument('<id>')
  .description('submit the schedule now')
  .action(async function (this: Command, id: string) {
    exitWith(await scheduleRun(id, out(this)));
  });

const daemon = program.command('daemon').description('the local daemon that executes runs');
daemon
  .command('start')
  .option('--detach', 'run in the background (log: ~/.shibaox/daemon.log)')
  .action(async function (this: Command, o: { detach?: boolean }) {
    exitWith(await daemonStart(o, out(this)));
  });
daemon
  .command('stop')
  .option('--force', 'cancel active runs instead of waiting for them')
  .action(async function (this: Command, o: { force?: boolean }) {
    exitWith(await daemonStop(o, out(this)));
  });
daemon.command('status').action(async function (this: Command) {
  exitWith(await daemonStatus(out(this)));
});

const providers = program.command('providers').description('model providers from the catalog');
providers
  .command('list')
  .description('list providers and whether they are configured')
  .option('--configured', 'only configured providers')
  .action((o: { configured?: boolean }) => providersListCommand(o));
providers
  .command('test')
  .argument('<id>')
  .description('make one short call to a provider')
  .option('--model <m>', 'model to test (default: the first catalog model)')
  .action(async (id: string, o: { model?: string }) => exitWith(await providersTestCommand(id, o)));
program
  .command('models')
  .description('show how each org role resolves to a model')
  .requiredOption('--org <dir>', 'org repo directory')
  .action((o: { org: string }) => modelsCommand(o));

const graph = program.command('graph').description('code knowledge graph (graphify)');
graph
  .command('build')
  .description('build graphify-out/graph.json for a project (installs graphify with uv)')
  .requiredOption('--project <path>', 'project directory')
  .action(async (o: { project: string }) => exitWith(await graphBuild(o)));
graph
  .command('update')
  .description('refresh the graph after code changes')
  .requiredOption('--project <path>', 'project directory')
  .action(async (o: { project: string }) => exitWith(await graphUpdate(o)));
graph
  .command('query')
  .argument('<question>')
  .description('ask the project graph a question')
  .requiredOption('--project <path>', 'project directory')
  .action(async (question: string, o: { project: string }) =>
    exitWith(await graphQuery(question, o)),
  );
const worktree = program.command('worktree').description('run worktrees (shibaox/<runId>)');
worktree
  .command('list')
  .description('list the run worktrees of a project')
  .requiredOption('--project <path>', 'project directory')
  .action((o: { project: string }) => worktreeList(o));
worktree
  .command('rm')
  .argument('<runId>')
  .description('remove a run worktree')
  .requiredOption('--project <path>', 'project directory')
  .option('--delete-branch', 'also delete the shibaox/<runId> branch')
  .action((runId: string, o: { project: string; deleteBranch?: boolean }) =>
    worktreeRemove(runId, o),
  );

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
