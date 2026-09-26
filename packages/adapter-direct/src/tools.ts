import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { type ExecutionContext, type RuntimeEvent, runCommand } from '@shibaox/core';
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
 * The command runs through a shell, so a first-token allowlist alone is not
 * enough: reject chaining (; & |), expansion/substitution ($ and backticks),
 * redirection (< >) and line breaks, which would let an allowed program
 * smuggle in another one, read host env vars or write outside the workspace.
 */
const SHELL_META = /[;&|`$<>\n\r]/;

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

/** An argument leaves the workspace if it is absolute, uses `~` or has a `..` segment. */
function leavesWorkspace(token: string): boolean {
  const bare = token.replace(/^['"]+|['"]+$/g, '');
  // also check the value part of `--flag=value` style arguments
  return [bare, ...bare.split('=').slice(1)].some(
    (t) => t.startsWith('/') || t.startsWith('~') || t.split(/[\\/]/).includes('..'),
  );
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
        const p = safePath(a.workspace, path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
        a.emit({ type: 'file_changed', path });
        return { ok: true, bytes: Buffer.byteLength(content) };
      }),
    }),
    run_command: tool({
      description: `Run one program (no shell operators); runs in the workspace; arguments must be relative paths inside it; this is an allowlist, not a sandbox. Allowed programs: ${[...allowed].join(', ') || 'none'}`,
      inputSchema: z.object({ command: z.string() }),
      execute: guarded('run_command', async ({ command }: { command: string }) => {
        const first = command.trim().split(/\s+/)[0] ?? '';
        if (!allowed.has(first))
          throw new Error(`command "${first}" is not allowed for role ${a.role.role}`);
        if (SHELL_META.test(command))
          throw new Error(
            'shell operators (; & | ` $ < > newline) are not allowed; run one program per call',
          );
        for (const tok of command.trim().split(/\s+/).slice(1))
          if (leavesWorkspace(tok)) throw new Error(`argument "${tok}" leaves the workspace`);
        const r = await runCommand({
          command,
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
