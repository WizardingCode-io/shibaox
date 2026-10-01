/** What the desktop app (Electron) adds to the page through its preload; absent in a browser. */
export interface DesktopBridge {
  platform: string;
  saveAs(name: string, content: string, encoding?: 'utf8' | 'base64'): Promise<string | undefined>;
  openWith(name: string, content: string, encoding?: 'utf8' | 'base64'): Promise<boolean>;
  reveal(path: string): Promise<void>;
}

export function desktopBridge(): DesktopBridge | undefined {
  const w = globalThis as { shibaoxDesktop?: DesktopBridge };
  return w.shibaoxDesktop;
}
