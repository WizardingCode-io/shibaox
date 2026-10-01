import { describe, expect, it } from 'vitest';
import { createFileBridge, type FileBridgeDeps, openable } from '../src/files.js';

function deps(over: Partial<FileBridgeDeps> = {}) {
  const written: { path: string; bytes: number }[] = [];
  const opened: string[] = [];
  const revealed: string[] = [];
  const asked: string[] = [];
  const d: FileBridgeDeps & {
    written: typeof written;
    opened: string[];
    revealed: string[];
    asked: string[];
  } = {
    written,
    opened,
    revealed,
    asked,
    appUrl: () => 'http://127.0.0.1:7434/app/#token=x',
    local: () => true,
    downloads: '/Users/me/Downloads',
    openedDir: '/Users/me/Library/Application Support/Shibaox/opened',
    saveDialog: async (defaultPath) => defaultPath,
    confirm: async (q) => {
      asked.push(q);
      return true;
    },
    write: (path, data) => {
      written.push({ path, bytes: data.length });
    },
    openPath: async (p) => {
      opened.push(p);
      return '';
    },
    reveal: (p) => {
      revealed.push(p);
    },
    now: () => 1_700_000_000_000,
    ...over,
  };
  return d;
}
const from = (url: string) => ({ senderUrl: url });

describe('the desktop file bridge', () => {
  it('answers only the app it shows: another origin, or no app yet, gets nothing', async () => {
    const d = deps();
    const b = createFileBridge(d);
    expect(
      await b.saveAs(from('http://evil.example/app/'), { name: 'a.txt', content: 'x' }),
    ).toEqual({ ok: false, reason: 'not the app' });
    expect(await b.openWith(from(''), { name: 'a.txt', content: 'x' })).toEqual({
      ok: false,
      reason: 'not the app',
    });
    const none = createFileBridge(deps({ appUrl: () => undefined }));
    expect(
      await none.saveAs(from('http://127.0.0.1:7434/app/'), { name: 'a.txt', content: 'x' }),
    ).toMatchObject({ ok: false });
    expect(d.written).toEqual([]);
  });
  it('saves where the dialog says, base64 for binaries, nothing when cancelled', async () => {
    const d = deps();
    const b = createFileBridge(d);
    const r = await b.saveAs(from('http://127.0.0.1:7434/app/#token=x'), {
      name: 'out/table.csv',
      content: 'a,b\n',
    });
    expect(r).toEqual({ ok: true, path: '/Users/me/Downloads/table.csv' });
    const png = await b.saveAs(from('http://127.0.0.1:7434/app/'), {
      name: 'x.png',
      content: Buffer.from([1, 2, 3]).toString('base64'),
      encoding: 'base64',
    });
    expect(png).toMatchObject({ ok: true });
    expect(d.written).toEqual([
      { path: '/Users/me/Downloads/table.csv', bytes: 4 },
      { path: '/Users/me/Downloads/x.png', bytes: 3 },
    ]);
    const cancelled = createFileBridge(deps({ saveDialog: async () => undefined }));
    expect(
      await cancelled.saveAs(from('http://127.0.0.1:7434/app/'), { name: 'a.txt', content: 'x' }),
    ).toEqual({ ok: false, reason: 'cancelled' });
  });
  it('opens documents under the opened folder; refuses kinds that would run, with the reason', async () => {
    const d = deps();
    const b = createFileBridge(d);
    const r = await b.openWith(from('http://127.0.0.1:7434/app/'), {
      name: 'table.csv',
      content: 'a,b\n',
    });
    expect(r).toEqual({ ok: true });
    expect(d.opened[0]).toBe(
      '/Users/me/Library/Application Support/Shibaox/opened/1700000000000/table.csv',
    );
    expect(d.asked).toEqual([]); // a local daemon's page: no question
    for (const name of [
      'run.py',
      'x.tool',
      'p.mobileconfig',
      'evil.command ',
      'evil.command.',
      'disk.iso',
      'what.xyz',
    ])
      expect(
        await b.openWith(from('http://127.0.0.1:7434/app/'), { name, content: 'x' }),
        name,
      ).toMatchObject({ ok: false, reason: expect.stringMatching(/would run|cannot be opened/) });
    expect(d.opened).toHaveLength(1);
  });
  it('a remote daemon page must be confirmed before anything opens; a refused confirm opens nothing', async () => {
    const d = deps({ local: () => false, confirm: async () => false });
    const b = createFileBridge(d);
    expect(
      await b.openWith(from('http://127.0.0.1:7434/app/'), { name: 'notes.md', content: '#' }),
    ).toEqual({ ok: false, reason: 'cancelled' });
    expect(d.opened).toEqual([]);
  });
  it('reveals only on a local daemon (the workspace is on this machine)', async () => {
    const d = deps();
    createFileBridge(d).reveal(from('http://127.0.0.1:7434/app/'), { path: '/w/proj/table.csv' });
    expect(d.revealed).toEqual(['/w/proj/table.csv']);
    const remote = deps({ local: () => false });
    createFileBridge(remote).reveal(from('http://127.0.0.1:7434/app/'), {
      path: '/w/proj/table.csv',
    });
    expect(remote.revealed).toEqual([]);
  });
});

describe('openable is an allowlist', () => {
  it('documents, data, code and images open; scripts, profiles, images-of-disks and the unknown do not', () => {
    for (const n of [
      'table.csv',
      'notes.md',
      'fib.js',
      'page.html',
      'photo.png',
      'data.json',
      'report.pdf',
      'sheet.xlsx',
      'deck.pptx',
      'x.ts',
      'style.css',
      'a.yaml',
      'Dockerfile',
    ])
      expect(openable(n), n).toBe(true);
    for (const n of [
      'run.py',
      'x.tool',
      'p.mobileconfig',
      'x.jnlp',
      'disk.iso',
      'evil.command ',
      'evil.command.',
      'a.sh',
      'b.exe',
      'c.scpt',
      'what.xyz',
      'a.ics',
      'l.fileloc',
    ])
      expect(openable(n), n).toBe(false);
  });
});
