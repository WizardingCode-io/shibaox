import { basename, join } from 'node:path';

/**
 * What the desktop hands to another app: documents, data, code and images the sheet itself
 * understands. An allowlist: anything whose default handler could run it (scripts, profiles,
 * disk images, shortcuts, calendar imports…) or that we do not know is refused.
 */
const OPENABLE = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'htm',
  'svg',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'go',
  'php',
  'sql',
  'diff',
  'patch',
  'log',
  'ini',
  'env',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'pdf',
  'xlsx',
  'xls',
  'docx',
  'doc',
  'pptx',
  'ppt',
  'numbers',
  'pages',
  'key',
  'rtf',
  'odt',
  'ods',
  'mp4',
  'mov',
  'webm',
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'glb',
  'zip',
]);
/** Code the user reads in an editor, never run by its default app on macOS. */
OPENABLE.delete('py'); // the Python Launcher runs it

/** The file name a copy gets: the base name, normalised, trailing dots and spaces gone, never empty. */
export function tempName(name: string): string {
  const base = basename(name.normalize('NFC').replace(/\\/g, '/'))
    .replace(/[\0/]/g, '')
    .trim()
    .replace(/[.\s]+$/, '');
  if (!base || base === '.' || base === '..') return 'file.txt';
  return base;
}

/** Whether a file of this name may be opened with the app that reads it. */
export function openable(name: string): boolean {
  const base = tempName(name);
  if (base === 'Dockerfile') return true;
  const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
  return ext !== '' && OPENABLE.has(ext);
}

export type BridgeResult = { ok: true; path?: string } | { ok: false; reason: string };
export interface BridgePayload {
  name?: unknown;
  content?: unknown;
  encoding?: unknown;
  path?: unknown;
}
export interface Sender {
  /** The URL of the frame that asked. */
  senderUrl: string;
}

/** The desktop pieces the bridge needs (Electron in the app, fakes in tests). */
export interface FileBridgeDeps {
  /** The URL the window shows right now (undefined before the app is up or on the offline page). */
  appUrl(): string | undefined;
  /** Whether that app is the local daemon's (its workspace is on this machine). */
  local(): boolean;
  downloads: string;
  /** Where copies handed to other apps are kept. */
  openedDir: string;
  /** The save dialog: the path chosen, or undefined when cancelled. */
  saveDialog(defaultPath: string): Promise<string | undefined>;
  /** A yes/no question (a remote daemon's page asking to open a file). */
  confirm(question: string): Promise<boolean>;
  write(path: string, data: Buffer): void;
  /** Opens with the default app; '' on success, else the error text (Electron's contract). */
  openPath(path: string): Promise<string>;
  reveal(path: string): void;
  now(): number;
}

const origin = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * What the app may ask the desktop for: the save dialog, "open with the app that reads it", the
 * Finder. Only the app the window shows is answered (same origin), a remote daemon's page is
 * asked before anything opens, and kinds that would run are refused: a page never launches
 * anything on its own.
 */
export function createFileBridge(d: FileBridgeDeps) {
  const fromApp = (s: Sender): boolean => {
    const app = d.appUrl();
    if (!app || !s.senderUrl) return false;
    const a = origin(app);
    return a !== undefined && a !== 'null' && origin(s.senderUrl) === a;
  };
  const decode = (p: BridgePayload) => {
    const name = typeof p.name === 'string' ? tempName(p.name) : 'file.txt';
    const content = typeof p.content === 'string' ? p.content : '';
    const data =
      p.encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    return { name, data };
  };
  let busy = false;
  const oneAtATime = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => {
    if (busy) return fallback;
    busy = true;
    try {
      return await f();
    } finally {
      busy = false;
    }
  };
  return {
    async saveAs(s: Sender, p: BridgePayload): Promise<BridgeResult> {
      if (!fromApp(s)) return { ok: false, reason: 'not the app' };
      return oneAtATime(
        async () => {
          const { name, data } = decode(p);
          const path = await d.saveDialog(join(d.downloads, name));
          if (!path) return { ok: false, reason: 'cancelled' };
          d.write(path, data);
          return { ok: true, path };
        },
        { ok: false, reason: 'busy' },
      );
    },
    async openWith(s: Sender, p: BridgePayload): Promise<BridgeResult> {
      if (!fromApp(s)) return { ok: false, reason: 'not the app' };
      const { name, data } = decode(p);
      if (!openable(name)) {
        const ext = name.includes('.') ? `.${name.split('.').pop()}` : name;
        return {
          ok: false,
          reason:
            /\.(py|pyw|sh|bash|zsh|command|tool|scpt|applescript|workflow|app|pkg|jar|exe|bat|cmd|ps1|mobileconfig|jnlp)$/i.test(
              name,
            )
              ? `${ext} would run rather than open: save it instead`
              : `${ext} cannot be opened from here: save it instead`,
        };
      }
      return oneAtATime(
        async () => {
          if (!d.local() && !(await d.confirm(`Open ${name} with the app that reads it?`)))
            return { ok: false, reason: 'cancelled' };
          const file = join(d.openedDir, String(d.now()), name);
          d.write(file, data);
          const err = await d.openPath(file);
          return err ? { ok: false, reason: err } : { ok: true };
        },
        { ok: false, reason: 'busy' },
      );
    },
    reveal(s: Sender, p: BridgePayload): void {
      if (!fromApp(s) || !d.local() || typeof p.path !== 'string') return;
      d.reveal(p.path);
    },
  };
}
