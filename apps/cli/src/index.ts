#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { graphBuild, graphQuery, graphUpdate } from './commands/graph.js';
import { initCommand } from './commands/init.js';
import { modelsCommand } from './commands/models.js';
import { providersListCommand, providersTestCommand } from './commands/providers.js';
import { replayCommand } from './commands/replay.js';
import { resumeRun } from './commands/resume.js';
import { type GraphMode, printState, runWorkflow } from './commands/run.js';
import { runsCommand } from './commands/runs.js';
import { worktreeList, worktreeRemove } from './commands/worktree.js';
import { ADAPTER_IDS, type AdapterId } from './wiring.js';

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

const program = new Command()
  .name('shibaox')
  .description('Agent OS over coding runtimes')
  .version('0.0.1');

program
  .command('init')
  .argument('[dir]', 'target directory', '.')
  .description('scaffold org/ and vault/')
  .action((dir: string) => initCommand(dir));
program
  .command('doctor')
  .description('check local prerequisites')
  .action(async () => exitWith(await doctorCommand()));
program
  .command('run')
  .argument('<workflow>')
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
  .option('--db <path>', 'events database path')
  .action(
    async (
      workflow: string,
      o: {
        org: string;
        project: string;
        input: string;
        adapter?: AdapterId;
        workspace?: 'inplace' | 'worktree';
        graph?: GraphMode;
        budget?: number;
        db?: string;
      },
    ) => {
      const state = await runWorkflow(workflow, o);
      printState(state);
      exitWith(state.status === 'completed' ? 0 : 2);
    },
  );
program
  .command('resume')
  .argument('<runId>')
  .description('continue a waiting, budget-paused or interrupted run')
  .requiredOption('--org <dir>', 'org repo directory')
  .addOption(
    new Option(
      '--adapter <id>',
      'runtime adapter (default: the one the run was started with)',
    ).choices(ADAPTER_IDS),
  )
  .addOption(graphOption())
  .option('--budget <usd>', 'new budget in USD (required to resume a budget pause)', parseBudget)
  .option('--db <path>', 'events database path')
  .action(
    async (
      runId: string,
      o: { org: string; adapter?: AdapterId; graph?: GraphMode; budget?: number; db?: string },
    ) => {
      const state = await resumeRun(runId, o);
      printState(state);
      exitWith(state.status === 'completed' ? 0 : 2);
    },
  );
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
program
  .command('runs')
  .requiredOption('--org <dir>')
  .option('--db <path>')
  .action((o: { org: string; db?: string }) => runsCommand(o.org, o.db));
program
  .command('replay')
  .argument('<runId>')
  .requiredOption('--org <dir>')
  .option('--db <path>')
  .action((runId: string, o: { org: string; db?: string }) => replayCommand(runId, o.org, o.db));

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
