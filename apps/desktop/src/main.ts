import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBridge } from '@wizardingcode/shibaox-bridge';
import { app, BrowserWindow, session, shell } from 'electron';
import { probeDaemon, startDaemonViaShell } from './daemon.js';
import { type BridgeHandle, type Launch, planLaunch, single } from './launch.js';
import { homeRoot, readRemote, socketPath } from './paths.js';

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

/** Never the token: URL fragments stay out of the logs. */
const shown = (text: string) => text.replace(/#token=[^\s'"]+/g, '#token=…');
const log = (line: string) => {
  if (SMOKE || process.env.SHIBAOX_DESKTOP_DEBUG) console.log(`[shibaox] ${shown(line)}`);
};

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
    void bridge?.close();
  });
}
