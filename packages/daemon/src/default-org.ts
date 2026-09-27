import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HomePaths } from './home.js';
import { scaffoldOrg } from './templates.js';

/**
 * The org used when a project has none of its own: `~/.shibaox/org` (with its vault beside
 * it), written from the template the first time and pointed at what this machine can run:
 * the Claude subscription when `claude` is installed, OpenRouter when its key is there,
 * else the template as is. An org that already exists is never touched.
 */
export function ensureDefaultOrg(
  paths: HomePaths,
  o: { env: NodeJS.ProcessEnv; claude: boolean },
): { root: string; created: boolean } {
  const root = paths.org;
  if (existsSync(join(root, 'org.yaml'))) return { root, created: false };
  scaffoldOrg(paths.root); // writes org/ and vault/ under the shibaox home
  const tiers = o.claude
    ? {
        strong: 'anthropic-subscription/claude-sonnet-5',
        cheap: 'anthropic-subscription/claude-haiku-4-5',
        decision: 'jev-latest',
        adapter: 'claude-code',
      }
    : o.env.OPENROUTER_API_KEY
      ? {
          strong: 'openrouter/anthropic/claude-sonnet-4.5',
          cheap: 'openrouter/qwen/qwen3-coder',
          decision: 'openrouter/typesafe/jev-router',
          adapter: 'direct',
        }
      : undefined;
  if (tiers) {
    writeFileSync(
      join(root, 'models.yaml'),
      [
        '# Model refs are <provider>/<model>; `shibaox models` lists them. Change these with',
        '# /tiers in the dashboard or by editing this file.',
        'providers: {}',
        'tiers:',
        `  strong: ${tiers.strong}`,
        `  cheap: ${tiers.cheap}`,
        `  decision: ${tiers.decision}`,
        'roles: {}',
        'gates: {}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'org.yaml'),
      [
        'organization: my-org',
        'budgets:',
        '  per_run_usd: 5',
        'teams: [engineering]',
        `adapter: ${tiers.adapter}`,
        'vault: ../vault',
        '',
      ].join('\n'),
    );
  }
  return { root, created: true };
}
