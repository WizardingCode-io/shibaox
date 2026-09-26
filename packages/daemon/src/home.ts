import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HomePaths {
  root: string;
  socket: string;
  pid: string;
  log: string;
  config: string;
  db: string;
}

/** `$SHIBAOX_HOME`, else `~/.shibaox`; the directory is created (0700). */
export function homePaths(env: NodeJS.ProcessEnv = process.env): HomePaths {
  const root = env.SHIBAOX_HOME || join(env.HOME || homedir(), '.shibaox');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    root,
    socket: join(root, 'daemon.sock'),
    pid: join(root, 'daemon.pid'),
    log: join(root, 'daemon.log'),
    config: join(root, 'daemon.yaml'),
    db: join(root, 'events.db'),
  };
}
