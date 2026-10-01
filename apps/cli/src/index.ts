#!/usr/bin/env node
import { ADAPTER_IDS, type AdapterId, type GraphMode } from '@wizardingcode/shibaox-daemon';
import { Command, InvalidArgumentError, Option } from 'commander';
import { connect } from './client.js';
import { appCommand } from './commands/app.js';
import type { McpAddOptions } from './commands/customize.js';
import {
  higgsfieldModeCommand,
  mcpAdd,
  mcpRemove,
  pluginsCommand,
  rolesList,
  skillsAdd,
  skillsList,
  skillsRemove,
} from './commands/customize.js';
import {
  daemonInstall,
  daemonStart,
  daemonStatus,
  daemonStop,
  daemonUninstall,
  serveCommand,
} from './commands/daemon.js';
import { doctorCommand } from './commands/doctor.js';
import { graphBuild, graphQuery, graphUpdate } from './commands/graph.js';
import { answerCommand, inboxCommand } from './commands/inbox.js';
import { initCommand } from './commands/init.js';
import { keysList, keysSet, keysUnset } from './commands/keys.js';
import { mcpList, mcpTest } from './commands/mcp.js';
import { modelsCommand } from './commands/models.js';
import { providersListCommand, providersTestCommand } from './commands/providers.js';
import { remoteClear, remoteSet, remoteShow } from './commands/remote.js';
import {
  ON_HELP,
  routineAdd,
  routineList,
  routinePause,
  routineRemove,
  routineRun,
  routineShow,
  routineSync,
  routineUpdate,
} from './commands/routine.js';
import {
  auditCommand,
  cancelCommand,
  filesCommand,
  followAny,
  replayCommand,
  resumeCommand,
  runCommand,
  runsCommand,
  runsPruneCommand,
  steerCommand,
} from './commands/run.js';
import { scheduleAdd, scheduleList, scheduleRemove, scheduleRun } from './commands/schedule.js';
import { tiersList, tiersSet } from './commands/tiers.js';
import { uiCommand } from './commands/ui.js';
import { upgradeCommand } from './commands/upgrade.js';
import { worktreeList, worktreeRemove } from './commands/worktree.js';
import { makeOut } from './output.js';
import { CLI_VERSION } from './version.js';

function parseBudget(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be a positive number');
  return n;
}

/** A repeatable option: every value, in order. */
const collect = (v: string, prev: string[]): string[] => [...prev, v];

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
  .option('--json', 'one JSON object per line instead of text')
  .option(
    '--remote <url>',
    'talk to a daemon at this URL (token: SHIBAOX_REMOTE_TOKEN or remote.json)',
  )
  .hook('preAction', (thisCommand) => {
    const remote = thisCommand.optsWithGlobals().remote as string | undefined;
    if (remote) process.env.SHIBAOX_REMOTE = remote;
  })
  .action(async () => exitWith(await uiCommand()));

program
  .command('ui')
  .description('the interactive dashboard (also: shibaox with no command)')
  .action(async () => exitWith(await uiCommand()));

program
  .command('init')
  .argument('[dir]', 'target directory', '.')
  .option(
    '--stack <stack>',
    'node | python | php-laravel | go | auto: also shibaox.yaml, typecheck and review gates, a weekly security scan',
  )
  .description('scaffold org/ and vault/ (and, with --stack, the files a team of that stack needs)')
  .action((dir: string, o: { stack?: string }) => {
    // no process.exit here: a piped stdout would lose the file list
    process.exitCode = initCommand(dir, o);
  });
program
  .command('upgrade')
  .description('update the installer checkout (~/.shibaox/app), rebuild and restart the daemon')
  .action(async function (this: Command) {
    exitWith(await upgradeCommand({ out: out(this) }));
  });

program
  .command('doctor')
  .description('check local prerequisites, the daemon and channels')
  .action(async () => exitWith(await doctorCommand()));

program
  .command('run')
  .argument('<workflow>')
  .description('submit a run to the daemon and follow it (Ctrl-C leaves it running)')
  .option(
    '--org <dir>',
    'org directory (default: ./org when it exists, else the org under ~/.shibaox)',
  )
  .requiredOption('--project <path>', 'project workspace')
  .option('--input <text>', 'request / spec text (required unless --issue)')
  .option(
    '--issue <n|url>',
    'a GitHub issue: its title and body become the request, it gets the report as a comment',
  )
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
  .option(
    '--model <ref>',
    'model for every task (provider/model, e.g. anthropic-subscription/claude-sonnet-5)',
  )
  .option('--budget <usd>', 'budget in USD (default: org budgets.per_run_usd)', parseBudget)
  .option(
    '--setup <what>',
    'dependency install in a worktree: auto (shibaox.yaml setup, else the lockfile), off, or a command',
  )
  .option('--detach', 'submit and return without following')
  .action(async function (this: Command, workflow: string, o: Record<string, unknown>) {
    if (!o.input && !o.issue) this.error('--input <text> or --issue <n> is required');
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
          model: o.model as string | undefined,
          setup: o.setup as string | undefined,
          issue: o.issue as string | undefined,
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
  .option('--since <cursor>', 'start after this frame cursor (see --json output)')
  .action(async function (this: Command, runId: string, o: { since?: string }) {
    const client = await connect();
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    exitWith(await followAny(client, runId, { since: o.since, signal: ac.signal }, out(this)));
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
  .command('app')
  .description(
    'the browser app (the dashboard as a web page): opens it against this daemon, or a remote one',
  )
  .option('--no-open', 'print the address, do not open the browser')
  .option('--port <n>', 'the bridge port (socket-only daemons; default: any free port)', (v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n < 0 || n > 65535)
      throw new InvalidArgumentError('the port must be a number between 0 and 65535');
    return n;
  })
  .action(async function (this: Command, o: { open?: boolean; port?: number }) {
    exitWith(await appCommand(o, out(this)));
  });
program
  .command('steer')
  .argument('<runId>')
  .argument('<note...>', 'what to tell the running task')
  .option('--node <id>', 'the node, when several tasks run at once')
  .description('redirect the running task of a run: it stops and starts again with your note')
  .action(async function (this: Command, runId: string, note: string[], o: { node?: string }) {
    exitWith(await steerCommand(runId, note, o, out(this)));
  });
program
  .command('cancel')
  .argument('<runId>')
  .description('cancel a run')
  .action(async function (this: Command, runId: string) {
    exitWith(await cancelCommand(runId, out(this)));
  });
const runs = program
  .command('runs')
  .description('list runs')
  .option('--status <status>', 'only runs in this status')
  .option('--org <dir>', 'only runs of this org')
  .action(async function (this: Command, o: { status?: string; org?: string }) {
    exitWith(await runsCommand(o, out(this)));
  });
runs
  .command('prune')
  .description('remove finished runs older than --before, with their events')
  .requiredOption('--before <age>', '30d, 12h, 45m, or an ISO date')
  .action(async function (this: Command, o: { before: string }) {
    exitWith(await runsPruneCommand(o, out(this)));
  });
program
  .command('audit')
  .argument('<runId>')
  .description('everything that happened in a run: nodes, tool calls, gates, approvals, git, cost')
  .option('--format <fmt>', 'md (default) or json')
  .option('--out <file>', 'write to this file instead of stdout')
  .action(async function (this: Command, runId: string, o: { format?: string; out?: string }) {
    exitWith(await auditCommand(runId, o, out(this)));
  });
program
  .command('files')
  .argument('<runId>')
  .argument('[path]', 'one file of the run workspace to print (or save with --out)')
  .description('the files a run created or changed; with a path, its content')
  .option('--out <file>', 'save the file here instead of printing it')
  .action(async function (
    this: Command,
    runId: string,
    path: string | undefined,
    o: { out?: string },
  ) {
    exitWith(await filesCommand(runId, path, o, out(this)));
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

const keys = program
  .command('keys')
  .description(
    'the key vault (API keys, tokens) shibaox uses; shared by the CLI, the dashboard and the daemon',
  );
keys.command('list').action(async function (this: Command) {
  exitWith(await keysList(out(this)));
});
keys
  .command('set')
  .argument('<name>', 'the key name, e.g. OPENROUTER_API_KEY')
  .argument('[value]', 'the value (or pipe it on stdin)')
  .action(async function (this: Command, name: string, value: string | undefined) {
    exitWith(await keysSet(name, value, out(this)));
  });
keys
  .command('unset')
  .argument('<name>')
  .action(async function (this: Command, name: string) {
    exitWith(await keysUnset(name, out(this)));
  });

const mcp = program
  .command('mcp')
  .description('the MCP servers of the org catalog (type: mcp): who uses them, are they reachable');
mcp
  .command('list')
  .option(
    '--org <dir>',
    'org directory (default: ./org when it exists, else the org under ~/.shibaox)',
  )
  .action(async function (this: Command, o: { org?: string }) {
    exitWith(await mcpList(o, out(this)));
  });
mcp
  .command('test')
  .argument('<id>', 'the catalog entry id')
  .option('--org <dir>', 'org directory')
  .action(async function (this: Command, id: string, o: { org?: string }) {
    exitWith(await mcpTest(id, o, out(this)));
  });
mcp
  .command('add')
  .description(
    'add an MCP server to the org catalog (catalog/<id>.yaml) and give it to roles; values that start with - take the = form (--arg=-y)',
  )
  .argument('<id>', 'the catalog entry id (letters, digits, - and _)')
  .option('--url <url>', 'an http server: its Streamable HTTP endpoint (https://…)')
  .option('--command <cmd>', 'a stdio server: the program to start')
  .option('--arg <arg>', 'an argument of the command (repeat it)', collect, [])
  .option('--key <NAME>', 'a vault key the server needs (repeat it)', collect, [])
  .option(
    '--header <NAME=VALUE>',
    `an http header; \${KEY} is filled from the vault (repeat it)`,
    collect,
    [],
  )
  .option(
    '--bearer-command <arg>',
    'http: the command whose output is the bearer token, one argument per flag (repeat it; no shell)',
    collect,
    [],
  )
  .option('--tool <name>', 'offer only these tools (repeat it)', collect, [])
  .option('--role <role>', 'give it to this role (repeat it)', collect, [])
  .option('--description <text>', 'what it is for (the catalog description)')
  .option('--timeout <ms>', 'start/call timeout in milliseconds', parseBudget)
  .option('--replace', 'overwrite an entry with the same id')
  .option('--org <dir>', 'org directory')
  .action(async function (this: Command, id: string, o: McpAddOptions) {
    exitWith(await mcpAdd(id, o, out(this)));
  });
mcp
  .command('rm')
  .description('remove an MCP server from the catalog (it is taken off every role first)')
  .argument('<id>', 'the catalog entry id')
  .option('--org <dir>', 'org directory')
  .action(async function (this: Command, id: string, o: { org?: string }) {
    exitWith(await mcpRemove(id, o, out(this)));
  });

const skills = program
  .command('skills')
  .description('the skills of the org (skills/<id>/SKILL.md): list, install, remove');
skills
  .command('list')
  .option(
    '--org <dir>',
    'org directory (default: ./org when it exists, else the org under ~/.shibaox)',
  )
  .action(async function (this: Command, o: { org?: string }) {
    exitWith(await skillsList(o, out(this)));
  });
skills
  .command('add')
  .description(
    'install skills from a repository (owner/repo[/path] or a git URL, cloned depth 1) or a folder on this machine',
  )
  .argument(
    '<source>',
    'owner/repo[/path] (github.com/ in front is fine), an https git URL, a folder (./x, /x, ~/x), or with --builtin a built-in skill id',
  )
  .option('--id <id>', 'install only this skill (repeat it)', collect, [])
  .option('--path <path>', 'where the skills are inside the repository')
  .option(
    '--folder',
    'the source is a folder on this machine (needed for a relative path like skills/x)',
  )
  .option('--builtin', 'the source is the id of a skill shipped with Shibaox (higgsfield, …)')
  .option('--replace', 'with --builtin: rewrite an existing SKILL.md with the built-in text')
  .option('--org <dir>', 'org directory')
  .action(async function (
    this: Command,
    source: string,
    o: {
      org?: string;
      id?: string[];
      path?: string;
      folder?: boolean;
      builtin?: boolean;
      replace?: boolean;
    },
  ) {
    exitWith(await skillsAdd(source, o, out(this)));
  });
skills
  .command('rm')
  .description('remove a skill (refused while roles use it, unless --detach)')
  .argument('<id>')
  .option('--detach', 'take it off the roles that use it first')
  .option('--org <dir>', 'org directory')
  .action(async function (this: Command, id: string, o: { org?: string; detach?: boolean }) {
    exitWith(await skillsRemove(id, o, out(this)));
  });

const roles = program.command('roles').description("the org's roles: model, MCP servers, skills");
roles
  .command('list')
  .option(
    '--org <dir>',
    'org directory (default: ./org when it exists, else the org under ~/.shibaox)',
  )
  .action(async function (this: Command, o: { org?: string }) {
    exitWith(await rolesList(o, out(this)));
  });

const plugins = program
  .command('plugins')
  .description('Higgsfield, GitHub, Telegram and TypeSafe / Jev: what is set up, what is missing')
  .action(async function (this: Command) {
    exitWith(await pluginsCommand(out(this)));
  });
plugins
  .command('higgsfield-mode')
  .description(
    'how Higgsfield generates: account (CLI login, plan credits), api (an API key), auto (the API when a key is saved)',
  )
  .argument('<mode>', 'auto, account or api')
  .action(async function (this: Command, mode: string) {
    exitWith(await higgsfieldModeCommand(mode, out(this)));
  });

const tiers = program
  .command('tiers')
  .description("the org's model tiers, judge, adapter and budget (no YAML editing)")
  .option(
    '--org <dir>',
    'org directory (default: ./org when it exists, else the org under ~/.shibaox)',
  )
  .action(async function (this: Command, o: { org?: string }) {
    exitWith(await tiersList(o, out(this)));
  });
tiers
  .command('set')
  .argument('<name>', 'strong | cheap | decision | judge | adapter | budget')
  .argument('<value>', 'a provider/model ref, jev-latest, an adapter, a USD amount, or "none"')
  .option('--org <dir>')
  .action(async function (this: Command, name: string, value: string) {
    // `--org` is also an option of the parent command, which takes it wherever it appears
    exitWith(await tiersSet(name, value, this.optsWithGlobals<{ org?: string }>(), out(this)));
  });

const schedule = program
  .command('schedule')
  .description('cron routines (the older name: see `shibaox routine`)');
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

program
  .command('serve')
  .description('run the daemon reachable over the network with a token (daemon.yaml listen)')
  .option('--host <host>', 'address to listen on (default: 0.0.0.0, or daemon.yaml listen.host)')
  .option('--port <port>', 'port (default: 7433, or daemon.yaml listen.port)', (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new InvalidArgumentError('bad port');
    return n;
  })
  .action(async function (this: Command, o: { host?: string; port?: number }) {
    exitWith(await serveCommand(o, out(this)));
  });

const remote = program
  .command('remote')
  .description('a daemon on another machine (shibaox serve there)');
remote
  .command('set')
  .argument('<url>', 'http(s)://host:port the daemon serves on')
  .argument('[token]', 'its SHIBAOX_DAEMON_TOKEN (or pipe it on stdin)')
  .description('send every command to that daemon (saved in ~/.shibaox/remote.json)')
  .action(async function (this: Command, url: string, token: string | undefined) {
    exitWith(await remoteSet(url, token, out(this)));
  });
remote
  .command('show')
  .description('where commands go')
  .action(function (this: Command) {
    exitWith(remoteShow(out(this)));
  });
remote
  .command('clear')
  .description('back to the local daemon')
  .action(function (this: Command) {
    exitWith(remoteClear(out(this)));
  });

const routine = program
  .command('routine')
  .description(
    'what the daemon does on its own: cron, GitHub issues/PRs/checks, a URL, a file, a command',
  );
routine
  .command('add')
  .argument('<workflow>')
  .requiredOption('--on <trigger>', ON_HELP)
  .requiredOption('--org <dir>')
  .requiredOption('--project <path>')
  .option('--input <text>', 'what to ask; what the trigger saw is appended as data')
  .option('--name <text>')
  .option('--description <text>', 'a line for the Scheduled screen')
  .option('--model <ref>', 'provider/model for the runs (default: the org tiers)')
  .option(
    '--approvals <policy>',
    'inbox (ask, default) | auto (tool approvals answered) | skip (human steps too)',
  )
  .option('--label <label>', 'github:issues|prs: only with this label')
  .option('--repo <owner/name>', 'github: the repository (default: the project origin)')
  .option('--branch <name>', 'github:checks: the branch to watch')
  .option('--every <seconds>', 'watchers: seconds between looks (default 120)', (v: string) =>
    Number(v),
  )
  .option('--mode <mode>', 'always | on_change (default: on_change for watchers, always for cron)')
  .option('--max-daily <usd>', 'stop for the day past this spend', parseBudget)
  .addOption(new Option('--adapter <id>').choices(ADAPTER_IDS))
  .option('--budget <usd>', 'budget in USD per run', parseBudget)
  .action(async function (this: Command, workflow: string, o: Record<string, unknown>) {
    exitWith(
      await routineAdd(
        workflow,
        {
          on: o.on as string,
          org: o.org as string,
          project: o.project as string,
          input: o.input as string | undefined,
          name: o.name as string | undefined,
          description: o.description as string | undefined,
          model: o.model as string | undefined,
          approvals: o.approvals as string | undefined,
          label: o.label as string | undefined,
          repo: o.repo as string | undefined,
          branch: o.branch as string | undefined,
          every: o.every as number | undefined,
          mode: o.mode as string | undefined,
          maxDaily: o.maxDaily as number | undefined,
          adapter: o.adapter as string | undefined,
          budget: o.budget as number | undefined,
        },
        out(this),
      ),
    );
  });
routine
  .command('update')
  .argument('<id>')
  .description('change a routine (an org routine edited here stops following its file)')
  .option('--on <trigger>', ON_HELP)
  .option('--project <path>')
  .option('--workflow <name>')
  .option('--input <text>')
  .option('--name <text>')
  .option('--description <text>')
  .option('--model <ref>', 'provider/model, or "" for the org tiers')
  .option('--approvals <policy>', 'inbox | auto | skip')
  .option('--label <label>')
  .option('--repo <owner/name>')
  .option('--branch <name>')
  .option('--every <seconds>', 'watchers: seconds between looks', (v: string) => Number(v))
  .option('--mode <mode>', 'always | on_change')
  .option('--max-daily <usd>', 'stop for the day past this spend', parseBudget)
  .addOption(new Option('--adapter <id>').choices(ADAPTER_IDS))
  .option('--budget <usd>', 'budget in USD per run', parseBudget)
  .action(async function (this: Command, id: string, o: Record<string, unknown>) {
    exitWith(
      await routineUpdate(
        id,
        {
          on: o.on as string | undefined,
          project: o.project as string | undefined,
          workflow: o.workflow as string | undefined,
          input: o.input as string | undefined,
          name: o.name as string | undefined,
          description: o.description as string | undefined,
          model: o.model as string | undefined,
          approvals: o.approvals as string | undefined,
          label: o.label as string | undefined,
          repo: o.repo as string | undefined,
          branch: o.branch as string | undefined,
          every: o.every as number | undefined,
          mode: o.mode as string | undefined,
          maxDaily: o.maxDaily as number | undefined,
          adapter: o.adapter as string | undefined,
          budget: o.budget as number | undefined,
        },
        out(this),
      ),
    );
  });
routine.command('list').action(async function (this: Command) {
  exitWith(await routineList(out(this)));
});
routine
  .command('show')
  .argument('<id>')
  .action(async function (this: Command, id: string) {
    exitWith(await routineShow(id, out(this)));
  });
routine
  .command('rm')
  .argument('<id>')
  .action(async function (this: Command, id: string) {
    exitWith(await routineRemove(id, out(this)));
  });
routine
  .command('run')
  .argument('<id>')
  .description('fire the routine now')
  .action(async function (this: Command, id: string) {
    exitWith(await routineRun(id, out(this)));
  });
routine
  .command('pause')
  .argument('<id>')
  .action(async function (this: Command, id: string) {
    exitWith(await routinePause(id, false, out(this)));
  });
routine
  .command('resume')
  .argument('<id>')
  .action(async function (this: Command, id: string) {
    exitWith(await routinePause(id, true, out(this)));
  });
routine
  .command('sync')
  .requiredOption('--org <dir>')
  .description('load org/routines/*.yaml into the daemon (routines as code)')
  .action(async function (this: Command, o: { org: string }) {
    exitWith(await routineSync(o, out(this)));
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
daemon
  .command('install')
  .description('run the daemon as a launchd service (starts at login, restarts if it exits)')
  .action(async function (this: Command) {
    exitWith(await daemonInstall(out(this)));
  });
daemon
  .command('uninstall')
  .description('remove the launchd service')
  .action(async function (this: Command) {
    exitWith(await daemonUninstall(out(this)));
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
