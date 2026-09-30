import { runArgv } from '@wizardingcode/shibaox-core';
import type { InboxItem } from '../inbox.js';
import { type RunReport, STATUS_SYMBOL } from '../runs/report.js';
import type { Channel } from './types.js';

export interface GithubChannelOptions {
  exec?: typeof runArgv;
  /** The environment `gh` runs with (the daemon's command env: GH_TOKEN from the vault). */
  env?: () => Record<string, string>;
  log?: (line: string) => void;
}

/** `github:owner/repo#N`: the issue or pull request a run was asked from. */
export function githubOrigin(
  origin: string | undefined,
): { repo: string; number: number } | undefined {
  const m = origin ? /^github:([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(origin) : null;
  return m ? { repo: m[1] as string, number: Number(m[2]) } : undefined;
}

/** The comment a finished run leaves on its issue. */
export function githubReportText(r: RunReport): string {
  const symbol = STATUS_SYMBOL[r.status] ?? '•';
  const head = `${symbol} **${r.workflow}** ${r.status === 'completed' ? 'done' : r.status.replace(/_/g, ' ')}`;
  const facts = [
    `${r.nodes.length} nodes`,
    `$${r.spentUsd.toFixed(2)}`,
    ...(r.durationMs !== undefined ? [`${Math.round(r.durationMs / 60_000)} min`] : []),
    ...(r.branch ? [`branch \`${r.branch}\``] : []),
  ].join(' · ');
  const lines = r.nodes
    .filter((n) => n.summary)
    .map((n) => `- ${n.id}: ${(n.summary ?? '').split('\n')[0]?.slice(0, 200)}`);
  const parts = [head, facts];
  if (lines.length) parts.push('', ...lines);
  if (r.needs)
    parts.push(
      '',
      `**Waiting for you:** ${r.needs} (\`shibaox inbox\`, then \`shibaox approve …\`)`,
    );
  if (r.error) parts.push('', `**Error:** ${r.error.split('\n')[0]?.slice(0, 300)}`);
  parts.push('', `<sub>shibaox · run ${r.runId}</sub>`);
  return parts.join('\n').slice(0, 60_000);
}

/**
 * GitHub as a channel: a run asked from an issue or a pull request (`origin
 * github:owner/repo#N`, what `shibaox run --issue N` sets) reports back as a comment there.
 * Approvals are never asked on GitHub: the inbox, the dashboard and Telegram do that.
 */
export function githubChannel(o: GithubChannelOptions = {}): Channel {
  const exec = o.exec ?? runArgv;
  return {
    id: 'github',
    async notify(_item: InboxItem) {
      // nothing: an approval on a public issue would invite anyone to answer it
    },
    async report(r) {
      const target = githubOrigin(r.origin);
      if (!target || r.reply !== undefined) return;
      const res = await exec({
        argv: [
          'gh',
          'issue',
          'comment',
          String(target.number),
          '--repo',
          target.repo,
          '--body',
          githubReportText(r),
        ],
        cwd: '/',
        timeoutMs: 60_000,
        env: o.env?.(),
      });
      if (res.exitCode !== 0)
        throw new Error(
          `gh issue comment failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`,
        );
      o.log?.(`[github] reported run ${r.runId} on ${target.repo}#${target.number}`);
    },
  };
}
