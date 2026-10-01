// What the browser app may ask the desktop for: a native save dialog, "open with the app that
// reads it", and showing a file in the Finder. Sandboxed; the main process checks the origin.
import { contextBridge, ipcRenderer } from 'electron';

type Result = { ok: true; path?: string } | { ok: false; reason: string };

contextBridge.exposeInMainWorld('shibaoxDesktop', {
  platform: process.platform,
  /** The save dialog: `{ ok, path }`, or `{ ok: false, reason }` (cancelled, not the app). */
  saveAs: (name: string, content: string, encoding?: 'utf8' | 'base64') =>
    ipcRenderer.invoke('shibaox:saveAs', { name, content, encoding }) as Promise<Result>,
  /** A copy opened with the app that reads it, or `{ ok: false, reason }` (a kind that would run, cancelled). */
  openWith: (name: string, content: string, encoding?: 'utf8' | 'base64') =>
    ipcRenderer.invoke('shibaox:openWith', { name, content, encoding }) as Promise<Result>,
  /** Shows the file in the Finder (local daemon only). */
  reveal: (path: string) => ipcRenderer.invoke('shibaox:reveal', { path }) as Promise<void>,
});
