import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runArgv } from '@shibaox/core';
import { homePaths } from '@shibaox/daemon';
import type { Out } from '../output.js';
import { daemonStop } from './daemon.js';

export interface UpgradeDeps {
  /** The checkout the installer keeps (`~/.shibaox/app` by default). */
  app?: string;
  exec?: typeof runArgv;
  /** Restarts the daemon on the new build (launchd starts it again after a stop). */
  restart?: () => Promise<void>;
  out: Out;
}

/** Where `install.sh` keeps the checkout: `$SHIBAOX_APP`, else `<home>/app`. */
export const appDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SHIBAOX_APP || join(homePaths(env).root, 'app');

/**
 * `shibaox upgrade`: pulls the installer's checkout, installs, builds and restarts the
 * daemon. Anything else (a development checkout) is upgraded the way it was installed.
 */
export async function upgradeCommand(_o: Record<string, never>, d: UpgradeDeps): Promise<number> {
  const app = d.app ?? appDir();
  const exec = d.exec ?? runArgv;
  const out = d.out;
  if (!existsSync(join(app, '.git'))) {
    out.line(
      `No installer checkout at ${app}: this shibaox runs from elsewhere. Upgrade it the way it was installed (git pull && pnpm install && pnpm build in its checkout), or install with scripts/install.sh.`,
    );
    out.obj({ upgraded: false, app });
    return 1;
  }
  const steps: string[][] = [
    ['git', 'pull', '--ff-only'],
    ['pnpm', 'install', '--frozen-lockfile'],
    ['pnpm', 'build'],
  ];
  for (const argv of steps) {
    out.line(`> ${argv.join(' ')}`);
    const r = await exec({ argv, cwd: app, timeoutMs: 15 * 60_000 });
    if (r.exitCode !== 0 || r.timedOut) {
      out.line(
        `${argv.join(' ')} failed${r.timedOut ? ' (timed out)' : ''}:\n${(r.stderr || r.stdout).slice(-2000)}`,
      );
      out.obj({ upgraded: false, app, step: argv.join(' ') });
      return 1;
    }
  }
  await (d.restart ?? (() => daemonStop({}, out).then(() => undefined)))();
  out.line(`Upgraded ${app}; the daemon restarts on the new build.`);
  out.obj({ upgraded: true, app });
  return 0;
}
