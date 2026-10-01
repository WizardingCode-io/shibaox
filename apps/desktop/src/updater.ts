/**
 * Keeps the packaged app current: a check after start and then on an interval, the update
 * downloaded in the background, one question when it is ready ("Restart now" / "Later"), and
 * "Check for Updates…" in the menu. Electron's updater is behind `UpdateSource` so this logic
 * is tested without Electron.
 */
export interface UpdateSource {
  /** Checks for a newer version and starts its download; the version found, or undefined when up to date. */
  check(): Promise<string | undefined>;
  /** Called once a downloaded update is validated and ready to install. */
  onDownloaded(cb: (version: string) => void): void;
  /** Called when a download or its validation fails: the version is not ready after all. */
  onError(cb: (reason: string) => void): void;
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
  /** Only a packaged app with update metadata can update itself. */
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

/** The usual failures in plain words; anything else keeps its first line. */
export function plainReason(reason: string): string {
  const first = reason.split('\n')[0] ?? reason;
  if (/latest-mac\.yml|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(first))
    return 'the latest release carries no update files yet.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|INTERNET_DISCONNECTED|network/i.test(first))
    return 'no connection to github.com (offline?).';
  return first;
}

export function startUpdater(source: UpdateSource, ui: UpdateUi, o: UpdaterOptions): Updater {
  const log = o.log ?? (() => {});
  const timers: unknown[] = [];
  let ready: string | undefined; // a version validated and waiting to be installed
  let asked: string | undefined; // the version the user was already asked about
  let failed: string | undefined; // why the last download or validation failed
  // one dialog at a time: a prompt waits for a message that is open, and the other way round
  let dialogs: Promise<unknown> = Promise.resolve();
  const dialog = <T>(f: () => Promise<T>): Promise<T> => {
    const p = dialogs.then(f, f);
    dialogs = p.catch(() => {});
    return p;
  };

  const offer = async (version: string): Promise<void> => {
    asked = version;
    const answer = await dialog(() => ui.ask(version));
    if (answer === 'restart' && ready === version) source.install();
  };
  const say = (message: string) => dialog(() => ui.say(message));
  const check = (): Promise<string | undefined> => source.check();

  if (o.packaged) {
    source.onDownloaded((version) => {
      ready = version;
      failed = undefined;
      if (asked === version) return;
      void offer(version).catch((e) => log(`update prompt failed: ${String(e)}`));
    });
    source.onError((reason) => {
      failed = reason;
      if (ready) log(`update ${ready} is not usable: ${reason}`);
      else log(`update failed: ${reason}`);
      ready = undefined;
    });
    const scheduled = () =>
      check().catch((e) =>
        log(`update check failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    timers.push(
      (o.setTimeout ?? setTimeout)(() => void scheduled(), o.startDelayMs ?? START_DELAY_MS),
    );
    timers.push(
      (o.setInterval ?? setInterval)(() => void scheduled(), o.intervalMs ?? INTERVAL_MS),
    );
  }

  return {
    async checkNow() {
      try {
        if (!o.packaged) {
          await say('Updates come with the packaged app: this is a development build.');
          return;
        }
        let found: string | undefined;
        try {
          found = await check();
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          log(`update check failed: ${reason}`);
          await say(`Shibaox could not check for updates: ${plainReason(reason)}`);
          return;
        }
        if (found && found === ready) return offer(found);
        if (found && failed) {
          await say(`Shibaox could not install ${found}: ${plainReason(failed)}`);
          return;
        }
        if (found) {
          await say(
            `Shibaox ${found} is downloading; you will be asked to restart when it is ready.`,
          );
          return;
        }
        if (ready) return offer(ready);
        await say(`Shibaox ${o.version} is the latest version.`);
      } catch (e) {
        log(`update dialog failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    stop() {
      for (const t of timers.splice(0))
        (o.clear ?? ((id: unknown) => clearTimeout(id as NodeJS.Timeout)))(t);
    },
  };
}
