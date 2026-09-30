import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from '@wizardingcode/shibaox-bridge';
import { app, BrowserWindow, shell } from 'electron';
import { probeDaemon, startDaemonViaShell } from './daemon.js';
import { type BridgeHandle, type Launch, planLaunch } from './launch.js';
import { homeRoot, readRemote, socketPath } from './paths.js';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIST = join(here, 'app');
const OFFLINE = join(here, 'offline.html');
/** The offline page's "Try again" link: caught before it navigates anywhere. */
const RETRY = 'shibaox-desktop://retry';
const SMOKE = process.env.SHIBAOX_DESKTOP_SMOKE === '1';

let win: BrowserWindow | undefined;
let bridge: BridgeHandle | undefined;
let current: Launch | undefined;

const log = (line: string) => {
  if (SMOKE || process.env.SHIBAOX_DESKTOP_DEBUG) console.log(`[shibaox] ${line}`);
};

/** Never the token: the URL fragment stays out of the logs. */
const shown = (url: string) => url.replace(/#.*$/, '');

async function launch(): Promise<Launch> {
  const root = homeRoot();
  await bridge?.close();
  bridge = undefined;
  const plan = await planLaunch({
    remote: () => readRemote(root),
    probe: () => probeDaemon(socketPath(root)),
    startDaemon: async () => startDaemonViaShell(),
    startBridge: (port) => startBridge({ socketPath: socketPath(root), dist: APP_DIST, port }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  });
  if (plan.kind === 'bridge') bridge = plan.bridge;
  current = plan;
  return plan;
}

async function show(w: BrowserWindow): Promise<void> {
  const plan = await launch();
  log(plan.kind === 'offline' ? `offline: ${plan.reason}` : `${plan.kind} ${shown(plan.url)}`);
  if (plan.kind === 'offline') await w.loadFile(OFFLINE, { query: { reason: plan.reason } });
  else await w.loadURL(plan.url);
}

const isApp = (url: string) =>
  current?.url !== undefined && new URL(url).origin === new URL(current.url).origin;

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
  w.webContents.on('will-navigate', (event, url) => {
    if (url === RETRY) {
      event.preventDefault();
      void show(w);
      return;
    }
    if (url.startsWith('file:') || isApp(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  w.on('closed', () => {
    if (win === w) win = undefined;
  });
  if (SMOKE)
    w.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const shell = await w.webContents
          .executeJavaScript('document.querySelector("aside") ? "shell" : "no-shell"')
          .catch(() => 'error');
        console.log(`[shibaox] smoke: ${current?.kind} title=${w.getTitle()} ${shell}`);
        app.quit();
      }, 2500);
    });
  return w;
}

app.setName('Shibaox');
app.whenReady().then(() => {
  win = createWindow();
  void show(win);
  app.on('activate', () => {
    if (!win) {
      win = createWindow();
      void show(win);
    }
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});
app.on('before-quit', () => {
  void bridge?.close();
});
