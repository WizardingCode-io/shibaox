// What the browser app may ask the desktop for: a native save dialog, "open with the app that
// reads it", and showing a file in the Finder. Sandboxed; the main process checks the origin.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('shibaoxDesktop', {
  platform: process.platform,
  /** The save dialog; the path saved to, or undefined when cancelled. */
  saveAs: (name: string, content: string, encoding?: 'utf8' | 'base64') =>
    ipcRenderer.invoke('shibaox:saveAs', { name, content, encoding }) as Promise<
      string | undefined
    >,
  /** Writes a temp copy and opens it with the default app; false when the kind is refused. */
  openWith: (name: string, content: string, encoding?: 'utf8' | 'base64') =>
    ipcRenderer.invoke('shibaox:openWith', { name, content, encoding }) as Promise<boolean>,
  /** Shows the file in the Finder. */
  reveal: (path: string) => ipcRenderer.invoke('shibaox:reveal', { path }) as Promise<void>,
});
