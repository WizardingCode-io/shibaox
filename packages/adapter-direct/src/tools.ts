import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  type AgentTool,
  type ApprovalHandler,
  argvHash,
  type ExecutionContext,
  ghPolicy,
  type RuntimeEvent,
  runArgv,
  validateJson,
} from '@wizardingcode/shibaox-core';
import type { Role } from '@wizardingcode/shibaox-schemas';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { safePath } from './safe-path.js';
import { fetchText } from './web.js';

export interface ToolArgs {
  workspace: string;
  role: Role;
  runId: string;
  nodeId: string;
  ctx: ExecutionContext;
  emit: (e: RuntimeEvent) => void;
  onFinish: (output: unknown, summary: string) => void;
  /** When set, `finish` refuses an output that does not match it (the model tries again). */
  outputSchema?: Record<string, unknown>;
  onFinishRefused?: (problems: string[]) => void;
  /** Answers push/deploy commands for roles with `approval_required`. */
  approvals: ApprovalHandler;
  /** argvHash → approved, for commands already answered on this node. */
  approvedCommands: Record<string, boolean>;
  /** Nobody answered in time: the adapter stops the task with `approval_pending`. */
  onSuspend: (approvalId: string) => void;
  commandTimeoutMs: number;
  maxFileBytes: number;
  /** When given, exposes a `graph_query` tool backed by this function. */
  graphQuery?: (question: string) => Promise<string>;
  /** Tools added by the daemon (orchestration, memory), exposed under their own names. */
  extraTools?: AgentTool[];
  /** `web_fetch` timeout and size (defaults 15 s, 200 kB). */
  webTimeoutMs?: number;
  webMaxBytes?: number;
}

function walk(dir: string, root: string, out: string[], limit: number): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || out.length >= limit) continue;
    const full = join(dir, name);
    // lstat: symlinks are listed as entries but never followed (no loops, no escapes)
    if (lstatSync(full).isDirectory()) walk(full, root, out, limit);
    else out.push(relative(root, full));
  }
}

/**
 * The command is split into argv and spawned without a shell, so nothing is
 * expanded (`$VAR`, `~`, globs, braces) and operators are plain text. The
 * metacharacters below are still refused so the model gets a clear error
 * instead of a program receiving a literal `;` or `>` it did not expect.
 */
const SHELL_META = /[;&|`$<>\n\r]/;

/**
 * Minimal shell-words parser: whitespace separates words; single and double
 * quotes group text literally (no escapes or expansion inside them); adjacent
 * quoted and bare parts join into one word (`'..'/x` is `../x`). Backslashes
 * are refused so that escaping cannot disguise a path from the argument guard.
 */
export function splitCommand(command: string): string[] {
  if (command.includes('\\'))
    throw new Error('backslashes are not allowed in commands; quote the argument instead');
  const argv: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) argv.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} quote in command`);
  if (inWord) argv.push(word);
  return argv;
}

/** Keys copied from the host env; everything else (API keys, tokens) is scrubbed. */
const ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TERM'] as const;

function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * An argument leaves the workspace if it (or the value of `--flag=value`, or
 * the value following a grouped short option like `-o/path` or `-rf../x`) is
 * absolute, uses `~` or has a `..` segment. Checked on the parsed argv, so
 * quoting cannot hide it.
 */
export function leavesWorkspace(arg: string): boolean {
  const shortOptValue = /^-[A-Za-z]+(.*)$/.exec(arg)?.[1];
  if (shortOptValue && leavesWorkspace(shortOptValue)) return true;
  const parts = [arg, ...arg.split('=').slice(1)];
  return parts.some(
    (t) => t.startsWith('/') || t.startsWith('~') || t.split(/[\\/]/).includes('..'),
  );
}

/** Renders a tool call's input as a short, single-line log fragment (≤120 chars). */
function summarizeInput(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input) ?? String(input);
  } catch {
    s = String(input);
  }
  return s.length > 120 ? s.slice(0, 120) : s;
}

/** Programs whose mutating verbs deploy (the full table lives in the Claude Code adapter). */
const DEPLOY_VERBS: Record<string, string[]> = {
  npm: ['publish', 'unpublish', 'dist-tag', 'dist-tags', 'deprecate'],
  pnpm: ['publish', 'unpublish', 'dist-tag', 'dist-tags', 'deprecate'],
  yarn: ['publish', 'unpublish', 'dist-tag', 'dist-tags', 'deprecate'],
  docker: ['push'],
};
const DEPLOY_PROGRAMS = [
  'vercel',
  'fly',
  'flyctl',
  'netlify',
  'heroku',
  'railway',
  'wrangler',
  'kubectl',
  'terraform',
  'helm',
];

/** Why a `gh` invocation is never run (extensions, aliases, auth, keys, gists, codespaces); undefined when it may run. */
export function ghRefusal(argv: string[]): string | undefined {
  const [program = '', ...rest] = argv;
  if (program !== 'gh') return undefined;
  const p = ghPolicy(rest);
  return p.kind === 'refused' ? p.reason : undefined;
}

/** `push` for git pushes, `deploy` for publishing/deploy programs (and `gh` writes), else `undefined`. */
export function approvalCategory(argv: string[]): 'push' | 'deploy' | undefined {
  const [program = '', ...rest] = argv;
  if (program === 'git')
    return rest.includes('push') || rest.includes('send-pack') ? 'push' : undefined;
  if (program === 'gh') return ghPolicy(rest).kind === 'deploy' ? 'deploy' : undefined;
  if (DEPLOY_PROGRAMS.includes(program)) return 'deploy';
  const verbs = DEPLOY_VERBS[program];
  if (verbs && rest.some((w) => verbs.includes(w) || (program === 'docker' && w === '--push')))
    return 'deploy';
  return undefined;
}

export const APPROVAL_PENDING = 'approval pending: the run is waiting for the inbox';

/** An argument naming a `.git` path could rewrite git config or hooks (code execution). */
function touchesGit(arg: string): boolean {
  return arg.split(/[\\/=]/).some((seg) => seg.toLowerCase() === '.git');
}

export function buildTools(a: ToolArgs): ToolSet {
  const guarded =
    <I, O>(name: string, fn: (input: I) => Promise<O> | O) =>
    async (input: I): Promise<O | { error: string }> => {
      const id = randomUUID();
      const started = Date.now();
      a.emit({ type: 'tool_use', id, name, input });
      a.ctx.log(`[direct] ${name} ${summarizeInput(input)}`);
      try {
        const output = await fn(input);
        a.emit({ type: 'tool_result', id, name, output, durationMs: Date.now() - started });
        return output;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        a.emit({
          type: 'tool_result',
          id,
          name,
          output: { error },
          durationMs: Date.now() - started,
        });
        return { error };
      }
    };
  // `read`/`write` in role.tools are capabilities (file tools), never runnable programs
  const allowed = new Set(a.role.tools.filter((t) => t !== 'read' && t !== 'write'));
  const readOnly = a.role.capabilities.includes('read-only');
  // `write` is the file-writing capability; programs run by allowlist whatever the role writes
  const canWrite = !readOnly && a.role.tools.includes('write');
  const network = a.role.permissions.network;
  const graphQuery = a.graphQuery;
  const extra: ToolSet = {};
  for (const t of a.extraTools ?? [])
    extra[t.name] = tool({
      description: t.description,
      inputSchema: t.input,
      execute: guarded(t.name, (input: Record<string, unknown>) => t.execute(input)),
    });
  return {
    list_files: tool({
      description: 'List files in the workspace (relative paths), up to 500 entries',
      inputSchema: z.object({ subdir: z.string().default('.') }),
      execute: guarded('list_files', ({ subdir }: { subdir: string }) => {
        const out: string[] = [];
        walk(safePath(a.workspace, subdir), a.workspace, out, 500);
        return { files: out };
      }),
    }),
    read_file: tool({
      description: 'Read a UTF-8 file from the workspace',
      inputSchema: z.object({ path: z.string() }),
      execute: guarded('read_file', ({ path }: { path: string }) => {
        const p = safePath(a.workspace, path);
        const size = statSync(p).size;
        if (size > a.maxFileBytes) throw new Error(`file too large (${size} bytes)`);
        return { content: readFileSync(p, 'utf8') };
      }),
    }),
    ...(canWrite
      ? {
          write_file: tool({
            description: 'Create or overwrite a UTF-8 file in the workspace',
            inputSchema: z.object({ path: z.string(), content: z.string() }),
            execute: guarded(
              'write_file',
              ({ path, content }: { path: string; content: string }) => {
                const p = safePath(a.workspace, path, { write: true });
                mkdirSync(dirname(p), { recursive: true });
                writeFileSync(p, content);
                a.emit({ type: 'file_changed', path });
                a.ctx.log(`[direct] wrote ${path}`);
                return { ok: true, bytes: Buffer.byteLength(content) };
              },
            ),
          }),
        }
      : {}),
    ...(readOnly
      ? {}
      : {
          run_command: tool({
            description: `Run one program without a shell (no operators, no $ or ~ expansion, no globs; single/double quotes group words literally); runs in the workspace; arguments must be relative paths inside it and must not touch .git; this is an allowlist, not a sandbox. Allowed programs: ${[...allowed].join(', ') || 'none'}`,
            inputSchema: z.object({ command: z.string() }),
            execute: guarded('run_command', async ({ command }: { command: string }) => {
              const argv = splitCommand(command);
              const program = argv[0] ?? '';
              if (!allowed.has(program))
                throw new Error(`command "${program}" is not allowed for role ${a.role.role}`);
              if (SHELL_META.test(command))
                throw new Error(
                  'shell operators (; & | ` $ < > newline) are not allowed; run one program per call',
                );
              for (const arg of argv.slice(1)) {
                if (leavesWorkspace(arg)) throw new Error(`argument "${arg}" leaves the workspace`);
                if (touchesGit(arg)) throw new Error(`argument "${arg}" targets .git`);
              }
              const refused = ghRefusal(argv);
              if (refused) throw new Error(`refused: ${refused}`);
              const category = approvalCategory(argv);
              if (category) {
                if (!a.role.permissions.approval_required.includes(category))
                  throw new Error(`${category} requires approval_required in the role`);
                const hash = argvHash(argv);
                const earlier = a.approvedCommands[hash];
                if (earlier === false)
                  throw new Error(`${category} was already denied by the human`);
                if (earlier !== true) {
                  const answer = await a.approvals.request(
                    {
                      runId: a.runId,
                      nodeId: a.nodeId,
                      role: a.role.role,
                      tool: 'Bash',
                      category,
                      program,
                      command,
                      argv,
                    },
                    { signal: a.ctx.signal },
                  );
                  if ('deferred' in answer) {
                    a.onSuspend(answer.approvalId);
                    throw new Error(APPROVAL_PENDING);
                  }
                  if (!answer.approved)
                    throw new Error(
                      `human rejected ${category}${answer.note ? `: ${answer.note}` : ''}`,
                    );
                }
              }
              const r = await runArgv({
                argv,
                cwd: a.workspace,
                timeoutMs: a.commandTimeoutMs,
                inheritEnv: false,
                env: scrubbedEnv(),
              });
              return {
                exitCode: r.exitCode,
                timedOut: r.timedOut,
                stdout: r.stdout.slice(-8000),
                stderr: r.stderr.slice(-8000),
              };
            }),
          }),
        }),
    ...(network.length > 0
      ? {
          web_fetch: tool({
            description: `Fetch a web page or API response over http(s) as text (HTML reduced to text, up to ${a.webMaxBytes ?? 200_000} bytes). Allowed hosts: ${network.join(', ')}`,
            inputSchema: z.object({ url: z.string() }),
            execute: guarded('web_fetch', ({ url }: { url: string }) =>
              fetchText(url, {
                timeoutMs: a.webTimeoutMs ?? 15_000,
                maxBytes: a.webMaxBytes ?? 200_000,
                allow: network,
              }),
            ),
          }),
        }
      : {}),
    ...extra,
    ...(graphQuery
      ? {
          graph_query: tool({
            description: 'Ask the knowledge graph a natural-language question about the codebase',
            inputSchema: z.object({ question: z.string() }),
            execute: guarded('graph_query', async ({ question }: { question: string }) => {
              const answer = await graphQuery(question);
              return { answer };
            }),
          }),
        }
      : {}),
    finish: tool({
      description:
        'Finish the task. Call exactly once when done, with the structured output and a one-line summary.',
      inputSchema: z.object({ output: z.unknown(), summary: z.string() }),
      execute: guarded('finish', ({ output, summary }: { output?: unknown; summary: string }) => {
        if (a.outputSchema) {
          const problems = validateJson(output, a.outputSchema);
          if (problems.length) {
            a.onFinishRefused?.(problems);
            return {
              ok: false,
              problems,
              hint: 'call finish again with an output that matches the output schema',
            };
          }
        }
        a.onFinish(output, summary);
        return { ok: true };
      }),
    }),
  };
}
