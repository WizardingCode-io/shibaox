import { describe, expect, it } from 'vitest';
import { approvalCategory } from '../src/tools.js';

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
    expect(approvalCategory(['gh', 'pr', 'review', '42', '--approve'])).toBeUndefined();
    expect(approvalCategory(['gh', 'issue', 'comment', '12', '--body', 'x'])).toBeUndefined();
    expect(approvalCategory(['gh', 'api', 'repos/acme/app'])).toBeUndefined();
  });
});
