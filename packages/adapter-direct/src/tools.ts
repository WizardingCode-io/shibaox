import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { type ExecutionContext, type RuntimeEvent, runArgv } from '@shibaox/core';
import type { Role } from '@shibaox/schemas';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { safePath } from './safe-path.js';

export interface ToolArgs {
  workspace: string;
  role: Role;
  ctx: ExecutionContext;
  emit: (e: RuntimeEvent) => void;
  onFinish: (output: unknown, summary: string) => void;
  commandTimeoutMs: number;
  maxFileBytes: number;
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
 * the tail of a short option like `-o/path`) is absolute, uses `~` or has a
 * `..` segment. Checked on the parsed argv, so quoting cannot hide it.
 */
function leavesWorkspace(arg: string): boolean {
  const parts = [arg, ...arg.split('=').slice(1)];
  if (/^-[A-Za-z]./.test(arg)) parts.push(arg.slice(2));
  return parts.some(
    (t) => t.startsWith('/') || t.startsWith('~') || t.split(/[\\/]/).includes('..'),
  );
}

/** An argument naming a `.git` path could rewrite git config or hooks (code execution). */
function touchesGit(arg: string): boolean {
  return arg.split(/[\\/=]/).some((seg) => seg.toLowerCase() === '.git');
}

export function buildTools(a: ToolArgs): ToolSet {
  const guarded =
    <I, O>(name: string, fn: (input: I) => Promise<O> | O) =>
    async (input: I): Promise<O | { error: string }> => {
      a.emit({ type: 'tool_use', name, input });
      try {
        const output = await fn(input);
        a.emit({ type: 'tool_result', name, output });
        return output;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        a.emit({ type: 'tool_result', name, output: { error } });
        return { error };
      }
    };
  const allowed = new Set(a.role.tools);
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
    write_file: tool({
      description: 'Create or overwrite a UTF-8 file in the workspace',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: guarded('write_file', ({ path, content }: { path: string; content: string }) => {
        const p = safePath(a.workspace, path, { write: true });
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
        a.emit({ type: 'file_changed', path });
        return { ok: true, bytes: Buffer.byteLength(content) };
      }),
    }),
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
    finish: tool({
      description:
        'Finish the task. Call exactly once when done, with the structured output and a one-line summary.',
      inputSchema: z.object({ output: z.unknown(), summary: z.string() }),
      execute: guarded('finish', ({ output, summary }: { output?: unknown; summary: string }) => {
        a.onFinish(output, summary);
        return { ok: true };
      }),
    }),
  };
}
