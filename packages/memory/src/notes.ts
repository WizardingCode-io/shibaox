import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureVault, safeVaultPath } from './vault.js';

export type MemoryScope = 'user' | 'project';

export interface MemoryNotesOptions {
  vault: string;
  /** The project's vault name (`[A-Za-z0-9._-]`). */
  project: string;
  now?: () => Date;
}

const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_PREAMBLE_BYTES = 4000;
const TAIL_LINES = 40;

/**
 * What the orchestrator remembers, as two append-only vault notes: `00-org/memory.md` for the
 * user (preferences, facts) and `10-projects/<project>/memory.md` for the project (decisions,
 * conventions). Lines are `- <YYYY-MM-DD> · <text>`.
 */
export class MemoryNotes {
  readonly vault: string;
  private readonly project: string;
  private readonly now: () => Date;

  constructor(o: MemoryNotesOptions) {
    if (!SAFE_ID_RE.test(o.project) || o.project.includes('..'))
      throw new Error(`invalid project "${o.project}"`);
    this.vault = o.vault;
    this.project = o.project;
    this.now = o.now ?? (() => new Date());
  }

  private rel(scope: MemoryScope): string {
    return scope === 'user'
      ? join('00-org', 'memory.md')
      : join('10-projects', this.project, 'memory.md');
  }

  private path(scope: MemoryScope): string {
    return safeVaultPath(this.vault, this.rel(scope));
  }

  private lines(scope: MemoryScope): string[] {
    const p = this.path(scope);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2));
  }

  remember(scope: MemoryScope, text: string): { path: string } {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('nothing to remember');
    ensureVault(this.vault);
    const p = this.path(scope);
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p))
      writeFileSync(
        p,
        `---\ntype: memory\nscope: ${scope}\n${scope === 'project' ? `project: ${JSON.stringify(this.project)}\n` : ''}---\n\n`,
      );
    appendFileSync(p, `- ${this.now().toISOString().slice(0, 10)} · ${clean}\n`);
    return { path: p };
  }

  /** Lines (newest last) containing every word of `query`, case-insensitively, from both notes. */
  recall(query: string, limit = 20): { scope: MemoryScope; line: string }[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const out: { scope: MemoryScope; line: string }[] = [];
    for (const scope of ['user', 'project'] as const)
      for (const line of this.lines(scope)) {
        const l = line.toLowerCase();
        if (words.every((w) => l.includes(w))) out.push({ scope, line });
      }
    return out.slice(-limit);
  }

  /** The prompt context: the profile summary and the last lines of each note, within `maxBytes`. */
  preamble(o: { profileSummary?: string; maxBytes?: number } = {}): string {
    const maxBytes = o.maxBytes ?? DEFAULT_PREAMBLE_BYTES;
    const sections: string[] = [];
    if (o.profileSummary) sections.push(`Project: ${o.profileSummary}`);
    const budget = { left: maxBytes - Buffer.byteLength(sections.join('\n\n')) - 64 };
    for (const [scope, title] of [
      ['user', 'What the user told you to remember'],
      ['project', 'What is known about this project'],
    ] as const) {
      const tail = this.lines(scope).slice(-TAIL_LINES);
      if (tail.length === 0) continue;
      const kept: string[] = [];
      for (const line of tail.reverse()) {
        const bytes = Buffer.byteLength(line) + 3;
        if (budget.left - bytes < 0) break;
        budget.left -= bytes;
        kept.unshift(`- ${line}`);
      }
      if (kept.length > 0) sections.push(`${title}:\n${kept.join('\n')}`);
    }
    return sections.join('\n\n');
  }
}
