/** What the desktop app (Electron) adds to the page through its preload; absent in a browser. */
export type BridgeResult = { ok: true; path?: string } | { ok: false; reason: string };
export interface DesktopBridge {
  platform: string;
  saveAs(name: string, content: string, encoding?: 'utf8' | 'base64'): Promise<BridgeResult>;
  openWith(name: string, content: string, encoding?: 'utf8' | 'base64'): Promise<BridgeResult>;
  reveal(path: string): Promise<void>;
}

export function desktopBridge(): DesktopBridge | undefined {
  const w = globalThis as { shibaoxDesktop?: DesktopBridge };
  return w.shibaoxDesktop;
}

/** A Blob as base64 (the bridge carries bytes as text). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
