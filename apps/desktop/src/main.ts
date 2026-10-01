import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBridge } from '@wizardingcode/shibaox-bridge';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  session,
  shell,
  autoUpdater as squirrel,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { probeDaemon, startDaemonViaShell } from './daemon.js';
import { type BridgeHandle, type Launch, planLaunch, single } from './launch.js';
import { homeRoot, readRemote, socketPath } from './paths.js';
import { startUpdater, type Updater, type UpdateSource, type UpdateUi } from './updater.js';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIST = join(here, 'app');
const OFFLINE = join(here, 'offline.html');
const OFFLINE_URL = pathToFileURL(OFFLINE).href;
/** The offline page's "Try again" link: caught before it navigates anywhere. */
const RETRY = 'shibaox-desktop://retry';
const SMOKE = process.env.SHIBAOX_DESKTOP_SMOKE === '1';

let win: BrowserWindow | undefined;
let bridge: BridgeHandle | undefined;
let current: Launch | undefined;
let updater: Updater | undefined;

/** Never the token: URL fragments stay out of the logs. */
const shown = (text: string) => text.replace(/#token=[^\s'"]+/g, '#token=…');
const log = (line: string) => {
  if (SMOKE || process.env.SHIBAOX_DESKTOP_DEBUG) console.log(`[shibaox] ${shown(line)}`);
};
/** What a user can show when updates fail: appended to ~/.shibaox/desktop.log (never a token). */
const persist = (line: string) => {
  log(line);
  try {
    appendFileSync(join(homeRoot(), 'desktop.log'), `${new Date().toISOString()} ${shown(line)}\n`);
  } catch {
    // no home directory to write to: the line stays in the debug output
  }
};

/** Ad-hoc builds (`pnpm dist`, a workflow run without the Apple secrets) are packaged with
 * `shibaoxUpdates: false`: Squirrel would refuse their updates, so they never check. */
function updatesEnabled(): boolean {
  if (!app.isPackaged || SMOKE) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      shibaoxUpdates?: boolean;
    };
    return pkg.shibaoxUpdates !== false;
  } catch {
    return false;
  }
}

async function launch(): Promise<Launch> {
  const root = homeRoot();
  await bridge?.close();
  bridge = undefined;
  const plan = await planLaunch({
    remote: () => readRemote(root),
    probe: () => probeDaemon(socketPath(root)),
    startDaemon: () => startDaemonViaShell(process.env, root),
    startBridge: (port) => startBridge({ socketPath: socketPath(root), dist: APP_DIST, port }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  });
  if (plan.kind === 'bridge') bridge = plan.bridge;
  current = plan;
  return plan;
}

const offline = (w: BrowserWindow, query: Record<string, string>) =>
  w.loadFile(OFFLINE, { query }).catch(() => {});

/** One launch at a time: "Try again" during a launch joins it instead of starting another. */
const show = single(async (): Promise<void> => {
  const w = win;
  if (!w) return;
  await offline(w, { state: 'starting' });
  let plan: Launch;
  try {
    plan = await launch();
  } catch (e) {
    plan = { kind: 'offline', reason: e instanceof Error ? e.message : String(e) };
    current = plan;
  }
  log(plan.kind === 'offline' ? `offline: ${plan.reason}` : `${plan.kind} ${plan.url}`);
  if (plan.kind === 'offline') return offline(w, { reason: plan.reason });
  try {
    await w.loadURL(plan.url);
  } catch (e) {
    // a remote daemon that is down, a bridge that died: the reason without the address's token
    const reason = shown(e instanceof Error ? e.message : String(e));
    current = { kind: 'offline', reason };
    await offline(w, { reason: `The app could not be loaded: ${reason}` });
  }
});

const isApp = (url: string) =>
  current?.url !== undefined && new URL(url).origin === new URL(current.url).origin;
const isOffline = (url: string) => url.split('?')[0] === OFFLINE_URL;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Shibaox',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.once('ready-to-show', () => w.show());
  // links out of the app (a PR, the wiki) go to the browser; nothing else opens a window here
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !isApp(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (url === RETRY) {
      event.preventDefault();
      if (current?.kind === 'offline') void show();
      return;
    }
    if (isOffline(url) || isApp(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  };
  w.webContents.on('will-navigate', guard);
  w.webContents.on('will-redirect', guard);
  w.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || isOffline(url)) return; // -3: aborted by a newer navigation
    current = { kind: 'offline', reason: description };
    void offline(w, { reason: `The app could not be loaded: ${description} (${code})` });
  });
  w.on('closed', () => {
    if (win === w) win = undefined;
  });
  if (SMOKE)
    w.webContents.on('did-finish-load', () => {
      if (current === undefined || w.webContents.getURL().includes('state=starting')) return;
      setTimeout(async () => {
        const marker = await w.webContents
          .executeJavaScript('document.querySelector("aside") ? "shell" : "no-shell"')
          .catch(() => 'error');
        console.log(`[shibaox] smoke: ${current?.kind} title=${w.getTitle()} ${marker}`);
        app.quit();
      }, 2500);
    });
  return w;
}

/**
 * Updates come from the GitHub releases of the repository (the zip and latest-mac.yml the
 * desktop workflow attaches): checked after start and every few hours, downloaded in the
 * background, installed on restart or on quit. A development build never checks.
 */
function startUpdates(): Updater {
  const say = (level: string, keep: boolean) => (m: unknown) =>
    (keep ? persist : log)(`updater ${level}: ${String(m).split('\n')[0]}`);
  autoUpdater.logger = {
    info: say('info', false),
    warn: say('warn', true),
    error: say('error', true),
    debug: say('debug', false),
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let version: string | undefined; // the version being downloaded
  const source: UpdateSource = {
    check: async () => {
      const r = await autoUpdater.checkForUpdates();
      if (!r?.isUpdateAvailable) return undefined;
      version = r.updateInfo.version;
      // the download runs on; its failure is reported by the error events, not left dangling
      r.downloadPromise?.catch(() => {});
      return version;
    },
    // electron-updater's own `update-downloaded` only means "zip on disk": the update is ready
    // once Squirrel (Electron's updater) has fetched and validated it
    onDownloaded: (cb) => {
      squirrel.on('update-downloaded', () => {
        if (version) cb(version);
      });
    },
    onError: (cb) => {
      const report = (e: unknown) => cb(e instanceof Error ? e.message : String(e));
      autoUpdater.on('error', report);
      squirrel.on('error', report);
    },
    install: () => autoUpdater.quitAndInstall(),
  };
  const parent = () => (win && !win.isDestroyed() && win.isVisible() ? win : undefined);
  const box = (options: Electron.MessageBoxOptions) => {
    const w = parent();
    return w ? dialog.showMessageBox(w, options) : dialog.showMessageBox(options);
  };
  const ui: UpdateUi = {
    ask: async (v) => {
      app.focus();
      const { response } = await box({
        type: 'info',
        message: `Shibaox ${v} is ready`,
        detail: 'Restart to update now. Later, it installs when you quit the app.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      return response === 0 ? 'restart' : 'later';
    },
    say: async (message) => {
      await box({ type: 'info', message, buttons: ['OK'] });
    },
  };
  return startUpdater(source, ui, {
    packaged: updatesEnabled(),
    version: app.getVersion(),
    log: persist,
  });
}

/** The macOS menu: the default roles plus "Check for Updates…". */
function installMenu(u: Updater): void {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Shibaox',
        submenu: [
          { role: 'about' },
          { label: 'Check for Updates…', click: () => void u.checkNow() },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

// Electron reports a failed load as a process warning that carries the whole address, token
// included: the default printer goes, one that strips fragments takes its place.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  console.error(`${w.name}: ${shown(w.message)}`);
});

app.setName('Shibaox');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    // no page here (local or remote) gets notifications, media, location... by default
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    updater = startUpdates();
    installMenu(updater);
    win = createWindow();
    void show();
    app.on('activate', () => {
      if (!win) {
        win = createWindow();
        void show();
      }
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || SMOKE) app.quit();
  });
  app.on('before-quit', () => {
    updater?.stop();
    void bridge?.close();
  });
}
