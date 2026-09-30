import { describe, expect, it } from 'vitest';
import { approvalCategory, ghRefusal } from '../src/tools.js';

describe('gh in the direct adapter', () => {
  it('merging, releasing, repo changes, secrets and writing API calls need a deploy approval', () => {
    expect(approvalCategory(['gh', 'pr', 'merge', '42'])).toBe('deploy');
    expect(approvalCategory(['gh', 'release', 'create', 'v1'])).toBe('deploy');
    expect(approvalCategory(['gh', 'repo', 'delete', 'acme/app'])).toBe('deploy');
    expect(approvalCategory(['gh', 'secret', 'set', 'X'])).toBe('deploy');
    expect(approvalCategory(['gh', 'api', '-X', 'PATCH', 'repos/acme/app'])).toBe('deploy');
    expect(approvalCategory(['gh', 'api', 'repos/acme/app/issues', '-F', 'title=x'])).toBe(
      'deploy',
    );
    expect(approvalCategory(['gh', 'workflow', 'run', 'ci.yml'])).toBe('deploy');
  });
  it('reading, reviewing and commenting do not', () => {
    expect(approvalCategory(['gh', 'pr', 'view', '42'])).toBeUndefined();
    expect(approvalCategory(['gh', 'pr', 'review', '42', '--approve'])).toBe('deploy');
    expect(approvalCategory(['gh', 'issue', 'comment', '12', '--body', 'x'])).toBe('deploy');
    expect(approvalCategory(['gh', '-R', 'acme/app', 'pr', 'merge', '1'])).toBe('deploy');
    expect(approvalCategory(['gh', 'api', '-XDELETE', 'repos/acme/app'])).toBe('deploy');
    expect(approvalCategory(['gh', 'api', 'repos/acme/app'])).toBeUndefined();
  });
});

describe('gh refusals in the direct adapter', () => {
  it('names why extension, alias, auth, keys, gists and codespaces are never run', () => {
    expect(ghRefusal(['gh', 'extension', 'install', 'evil/x'])).toMatch(/extension/);
    expect(ghRefusal(['gh', 'auth', 'token'])).toMatch(/auth/);
    expect(ghRefusal(['gh', 'pr', 'view', '1'])).toBeUndefined();
  });
});
