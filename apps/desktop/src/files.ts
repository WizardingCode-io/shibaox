import { basename } from 'node:path';

/** Kinds the desktop never hands to another app: anything that would run rather than open. */
const NEVER = new Set([
  'command',
  'sh',
  'bash',
  'zsh',
  'fish',
  'app',
  'pkg',
  'mpkg',
  'dmg',
  'jar',
  'exe',
  'msi',
  'bat',
  'cmd',
  'ps1',
  'scpt',
  'scptd',
  'applescript',
  'workflow',
  'action',
  'terminal',
  'webloc',
  'url',
  'inetloc',
  'lnk',
  'vbs',
  'js.lnk',
  'service',
  'plugin',
  'bundle',
  'kext',
  'dylib',
  'so',
]);

/** Whether a file of this name may be opened with the app that reads it (documents, data, code, images). */
export function openable(name: string): boolean {
  const base = basename(name);
  const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
  return !NEVER.has(ext);
}

/** The file name a temp copy gets: the base name only, with its extension, never empty. */
export function tempName(name: string): string {
  const base = basename(name.replace(/\\/g, '/')).replace(/[\0/]/g, '');
  if (!base || base === '.' || base === '..') return 'file.txt';
  return base;
}
