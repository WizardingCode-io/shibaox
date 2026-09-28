import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runArgv } from '@wizardingcode/shibaox-core';

/** `<project>/graphify-out/graph.json`, where `graphify extract`/`update` write the graph. */
export const graphJsonPath = (project: string): string =>
  join(project, 'graphify-out', 'graph.json');

export interface GraphifyOptions {
  exec?: typeof runArgv;
  uvBin?: string;
}

/**
 * Thin wrapper around the `graphify` CLI (installed via `uv tool install
 * graphifyy`). Every method returns `{ ok, message }` (or a plain string for
 * `query`) and never throws for a missing tool: the CLI exiting non-zero, or
 * `uv`/`graphify` not being on PATH, is reported back instead of raised.
 */
export class Graphify {
  private readonly exec: typeof runArgv;
  private readonly uv: string;

  constructor(opts: GraphifyOptions = {}) {
    this.exec = opts.exec ?? runArgv;
    this.uv = opts.uvBin ?? 'uv';
  }

  private run(argv: string[], cwd = process.cwd(), timeoutMs = 600_000) {
    return this.exec({ argv, cwd, timeoutMs });
  }

  /** `graphify --help` exit 0. */
  async isInstalled(): Promise<boolean> {
    const r = await this.run(['graphify', '--help'], process.cwd(), 20_000);
    return r.exitCode === 0;
  }

  /** Tries `uv tool install graphifyy`; reports how to install `uv` when it is missing. */
  async ensureInstalled(): Promise<{ ok: boolean; message: string }> {
    if (await this.isInstalled()) return { ok: true, message: 'graphify is installed' };
    const uv = await this.run([this.uv, '--version'], process.cwd(), 20_000);
    if (uv.exitCode !== 0)
      return {
        ok: false,
        message:
          'uv not found: install uv (https://docs.astral.sh/uv/) then run: uv tool install graphifyy',
      };
    const r = await this.run([this.uv, 'tool', 'install', 'graphifyy']);
    return r.exitCode === 0
      ? { ok: true, message: 'installed graphifyy with uv' }
      : { ok: false, message: `uv tool install graphifyy failed: ${r.stderr.slice(-500)}` };
  }

  /** `uv tool run --from graphifyy python -c "import sys; print(sys.executable)"`. */
  async pythonPath(): Promise<string | undefined> {
    const r = await this.run(
      [
        this.uv,
        'tool',
        'run',
        '--from',
        'graphifyy',
        'python',
        '-c',
        'import sys; print(sys.executable)',
      ],
      process.cwd(),
      60_000,
    );
    return r.exitCode === 0 ? r.stdout.trim() : undefined;
  }

  /** `graphify extract <project> --code-only`; `graphJson` is set when the file was produced. */
  async build(project: string): Promise<{ ok: boolean; graphJson?: string; message: string }> {
    const abs = resolve(project);
    const r = await this.run(['graphify', 'extract', abs, '--code-only'], abs);
    if (r.exitCode !== 0)
      return {
        ok: false,
        message: `graphify extract failed: ${(r.stderr || r.stdout).slice(-500)}`,
      };
    const graphJson = graphJsonPath(abs);
    return existsSync(graphJson)
      ? { ok: true, graphJson, message: 'graph built' }
      : { ok: false, message: `graphify extract finished but ${graphJson} was not produced` };
  }

  /** `graphify update <project>`. */
  async update(project: string): Promise<{ ok: boolean; message: string }> {
    const abs = resolve(project);
    const r = await this.run(['graphify', 'update', abs], abs);
    return r.exitCode === 0
      ? { ok: true, message: 'graph updated' }
      : { ok: false, message: `graphify update failed: ${(r.stderr || r.stdout).slice(-500)}` };
  }

  /** `graphify query "<question>" --graph <graph.json> --budget <budget>`. */
  async query(project: string, question: string, budget = 1500): Promise<string> {
    const abs = resolve(project);
    const r = await this.run(
      ['graphify', 'query', question, '--graph', graphJsonPath(abs), '--budget', String(budget)],
      abs,
      120_000,
    );
    return r.exitCode === 0
      ? r.stdout.trim()
      : `graph query failed: ${(r.stderr || r.stdout).slice(-300)}`;
  }

  /** MCP stdio server config: `<python> -m graphify.serve <graphJson>`. */
  mcpServerConfig(
    graphJson: string,
    python: string,
  ): { type: 'stdio'; command: string; args: string[] } {
    return { type: 'stdio', command: python, args: ['-m', 'graphify.serve', graphJson] };
  }
}
