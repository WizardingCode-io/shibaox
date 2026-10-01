/**
 * Keeps the packaged app current: a check after start and then on an interval, the update
 * downloaded in the background, one question when it is ready ("Restart now" / "Later"), and
 * "Check for Updates…" in the menu. Electron's updater is behind `UpdateSource` so this logic
 * is tested without Electron.
 */
export interface UpdateSource {
  /** Checks for a newer version and starts its download; the version found, or undefined when up to date. */
  check(): Promise<string | undefined>;
  /** Called once a downloaded update is ready to install. */
  onDownloaded(cb: (version: string) => void): void;
  /** Quits and installs the downloaded update. */
  install(): void;
}

export interface UpdateUi {
  /** "Shibaox <version> is ready": restart now, or later (it installs on quit anyway). */
  ask(version: string): Promise<'restart' | 'later'>;
  /** A plain message for a check the user asked for. */
  say(message: string): Promise<void>;
}

export interface UpdaterOptions {
  /** Only a packaged app can update itself (`app.isPackaged`). */
  packaged: boolean;
  version: string;
  startDelayMs?: number;
  intervalMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clear?: (id: unknown) => void;
  log?: (line: string) => void;
}

export interface Updater {
  /** A check the user asked for: it says what it found. */
  checkNow(): Promise<void>;
  stop(): void;
}

const START_DELAY_MS = 10_000;
const INTERVAL_MS = 4 * 3600_000;

export function startUpdater(source: UpdateSource, ui: UpdateUi, o: UpdaterOptions): Updater {
  const log = o.log ?? (() => {});
  const timers: unknown[] = [];
  let ready: string | undefined; // a version downloaded and waiting to be installed
  let asked: string | undefined; // the version the user was already asked about

  const offer = async (version: string): Promise<void> => {
    asked = version;
    const answer = await ui.ask(version);
    if (answer === 'restart') source.install();
  };

  if (o.packaged) {
    source.onDownloaded((version) => {
      ready = version;
      if (asked === version) return;
      void offer(version).catch((e) => log(`update prompt failed: ${String(e)}`));
    });
    const check = () =>
      source
        .check()
        .catch((e) => log(`update check failed: ${e instanceof Error ? e.message : String(e)}`));
    timers.push((o.setTimeout ?? setTimeout)(() => void check(), o.startDelayMs ?? START_DELAY_MS));
    timers.push((o.setInterval ?? setInterval)(() => void check(), o.intervalMs ?? INTERVAL_MS));
  }

  return {
    async checkNow() {
      if (!o.packaged) {
        await ui.say('Updates come with the packaged app: this is a development build.');
        return;
      }
      if (ready) return offer(ready);
      let found: string | undefined;
      try {
        found = await source.check();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log(`update check failed: ${reason}`);
        await ui.say(`Shibaox could not check for updates: ${reason}`);
        return;
      }
      await ui.say(
        found
          ? `Shibaox ${found} is downloading; you will be asked to restart when it is ready.`
          : `Shibaox ${o.version} is the latest version.`,
      );
    },
    stop() {
      for (const t of timers.splice(0))
        (o.clear ?? ((id: unknown) => clearTimeout(id as NodeJS.Timeout)))(t);
    },
  };
}
