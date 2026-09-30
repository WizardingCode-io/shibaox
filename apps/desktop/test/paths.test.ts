import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { homeRoot, readRemote, socketPath } from '../src/paths.js';

describe('paths', () => {
  it('the home is SHIBAOX_HOME, else ~/.shibaox; the socket lives in it', () => {
    expect(homeRoot({ SHIBAOX_HOME: '/x/home', HOME: '/u' })).toBe('/x/home');
    expect(homeRoot({ HOME: '/u' })).toBe('/u/.shibaox');
    expect(socketPath('/u/.shibaox')).toBe('/u/.shibaox/daemon.sock');
  });

  it('reads remote.json, and says what is wrong with a bad one instead of ignoring it', () => {
    const root = mkdtempSync(join(tmpdir(), 'shx-desk-'));
    expect(readRemote(root)).toBeUndefined();
    writeFileSync(
      join(root, 'remote.json'),
      '{"baseUrl":"https://vps.example:7433/","token":"abc"}',
    );
    expect(readRemote(root)).toEqual({ baseUrl: 'https://vps.example:7433', token: 'abc' });
    writeFileSync(join(root, 'remote.json'), '{"baseUrl":"https://vps.example"}');
    expect(readRemote(root)).toEqual({ baseUrl: 'https://vps.example', token: undefined });
    writeFileSync(join(root, 'remote.json'), 'not json');
    expect(readRemote(root)).toMatchObject({ error: expect.stringContaining('remote.json') });
    writeFileSync(join(root, 'remote.json'), '{"token":"abc"}');
    expect(readRemote(root)).toMatchObject({ error: expect.stringContaining('baseUrl') });
    writeFileSync(join(root, 'remote.json'), '{"baseUrl":"ftp://x"}');
    expect(readRemote(root)).toMatchObject({ error: expect.stringContaining('http') });
  });
});
