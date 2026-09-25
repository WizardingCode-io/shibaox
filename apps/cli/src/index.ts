#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { replayCommand } from './commands/replay.js';
import { resumeRun } from './commands/resume.js';
import { printState, runWorkflow } from './commands/run.js';
import { runsCommand } from './commands/runs.js';

function parseBudget(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be a positive number');
  return n;
}

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
  .action(async () => process.exit(await doctorCommand()));
program
  .command('run')
  .argument('<workflow>')
  .requiredOption('--org <dir>', 'org repo directory')
  .requiredOption('--project <path>', 'project workspace')
  .requiredOption('--input <text>', 'request / spec text')
  .addOption(
    new Option('--adapter <id>', 'runtime adapter (phase 1A: mock)')
      .choices(['mock'])
      .default('mock'),
  )
  .option('--budget <usd>', 'budget in USD (default: org budgets.per_run_usd)', parseBudget)
  .option('--db <path>', 'events database path')
  .action(
    async (
      workflow: string,
      o: {
        org: string;
        project: string;
        input: string;
        adapter: 'mock';
        budget?: number;
        db?: string;
      },
    ) => {
      const state = await runWorkflow(workflow, o);
      printState(state);
      process.exit(state.status === 'completed' ? 0 : 2);
    },
  );
program
  .command('resume')
  .argument('<runId>')
  .description('continue a waiting, budget-paused or interrupted run')
  .requiredOption('--org <dir>', 'org repo directory')
  .option('--budget <usd>', 'new budget in USD (required to resume a budget pause)', parseBudget)
  .option('--db <path>', 'events database path')
  .action(async (runId: string, o: { org: string; budget?: number; db?: string }) => {
    const state = await resumeRun(runId, o);
    printState(state);
    process.exit(state.status === 'completed' ? 0 : 2);
  });
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

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
