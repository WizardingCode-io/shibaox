#!/usr/bin/env node
import { Command } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { replayCommand } from './commands/replay.js';
import { printState, runWorkflow } from './commands/run.js';
import { runsCommand } from './commands/runs.js';

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
  .option('--adapter <id>', 'runtime adapter (phase 1A: mock)', 'mock')
  .option('--budget <usd>', 'budget in USD', (v) => Number(v))
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

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
