import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runArgv } from '@wizardingcode/shibaox-core';
import { homePaths } from '@wizardingcode/shibaox-daemon';
import type { Out } from '../output.js';
import { daemonStop } from './daemon.js';

export interface UpgradeDeps {
  /** The checkout the installer keeps (`~/.shibaox/app` by default). */
  app?: string;
  /** The CLI file that is running (`process.argv[1]`): it must belong to that checkout. */
  cli?: string;
  exec?: typeof runArgv;
  /** Stops the daemon so the next start runs the new build; resolves with what happened. */
  restart?: () => Promise<string>;
  out: Out;
}

/** Where `install.sh` keeps the checkout: `$SHIBAOX_APP`, else `<home>/app`. */
export const appDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SHIBAOX_APP || join(homePaths(env).root, 'app');

/** Stops the daemon (launchd starts it again) and says what that means for the new build. */
async function restartDaemon(out: Out): Promise<string> {
  const r: { stopped?: boolean } = {};
  await daemonStop({}, { ...out, line: () => {}, obj: (o) => Object.assign(r, o) });
  return r.stopped
    ? 'the daemon was stopped: the service starts it again on the new build (else the next command does)'
    : 'no daemon was running: the next command starts it on the new build';
}

/**
 * `shibaox upgrade`: pulls the installer's checkout, installs, builds and restarts the
 * daemon. Anything else (a development checkout) is upgraded the way it was installed.
 */
export async function upgradeCommand(d: UpgradeDeps): Promise<number> {
  const app = d.app ?? appDir();
  const exec = d.exec ?? runArgv;
  const out = d.out;
  const git = async (...args: string[]) => {
    const r = await exec({ argv: ['git', ...args], cwd: app, timeoutMs: 60_000 });
    return r.exitCode === 0 ? r.stdout.trim() : undefined;
  };
  const cliPath = d.cli ?? process.argv[1];
  if (cliPath && /\/node_modules\/shibaox\//.test(resolve(cliPath))) {
    out.line(
      'This shibaox was installed from npm: update it with `npm i -g shibaox@latest`, then `shibaox daemon stop` so the daemon restarts on the new build.',
    );
    out.obj({ upgraded: false, npm: true });
    return 1;
  }
  if (!existsSync(join(app, '.git'))) {
    out.line(
      `No installer checkout at ${app}: this shibaox runs from elsewhere. Upgrade it the way it was installed (git pull && pnpm install && pnpm build in its checkout), or install with scripts/install.sh.`,
    );
    out.obj({ upgraded: false, app });
    return 1;
  }
  const cli = d.cli ?? process.argv[1];
  if (cli && !resolve(cli).startsWith(`${resolve(app)}/`)) {
    out.line(
      `This shibaox runs from ${resolve(cli)}, not from the installer checkout ${app}: upgrade that checkout the way it was installed, or run ${join(app, 'apps/cli/dist/index.js')} upgrade.`,
    );
    out.obj({ upgraded: false, app, cli });
    return 1;
  }
  if ((await git('symbolic-ref', '-q', 'HEAD')) === undefined) {
    out.line(
      `${app} is at a tag or a fixed commit (SHIBAOX_REF), not a branch: rerun install.sh with SHIBAOX_REF=<the new tag> to move it.`,
    );
    out.obj({ upgraded: false, app, detached: true });
    return 1;
  }
  const before = (await git('rev-parse', 'HEAD')) ?? '?';
  const steps: string[][] = [
    ['git', 'pull', '--ff-only'],
    ['pnpm', 'install', '--frozen-lockfile'],
    ['pnpm', 'build'],
  ];
  out.line(`Upgrading ${app} (a few minutes: dependencies and build)…`);
  for (const argv of steps) {
    out.line(`> ${argv.join(' ')}`);
    const r = await exec({ argv, cwd: app, timeoutMs: 15 * 60_000 });
    if (r.exitCode !== 0 || r.timedOut) {
      out.line(
        `${argv.join(' ')} failed${r.timedOut ? ' (timed out)' : ''}:\n${(r.stderr || r.stdout).slice(-2000)}`,
      );
      out.line(
        `The checkout is at ${((await git('rev-parse', 'HEAD')) ?? '?').slice(0, 7)} and the running daemon keeps the old build until it restarts. To go back: git -C ${app} reset --hard ${before.slice(0, 7)} && pnpm install && pnpm build`,
      );
      out.obj({ upgraded: false, app, step: argv.join(' '), before });
      return 1;
    }
    if (argv[0] === 'git' && ((await git('rev-parse', 'HEAD')) ?? '?') === before) {
      out.line(`Already up to date (${before.slice(0, 7)}).`);
      out.obj({ upgraded: false, app, upToDate: true });
      return 0;
    }
  }
  const after = ((await git('rev-parse', 'HEAD')) ?? '?').slice(0, 7);
  const note = await (d.restart ? d.restart() : restartDaemon(out));
  out.line(`Upgraded ${app} (${before.slice(0, 7)} → ${after}); ${note}.`);
  out.obj({ upgraded: true, app, before, after });
  return 0;
}
