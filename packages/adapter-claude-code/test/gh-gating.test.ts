import { describe, expect, it } from 'vitest';
import { analyseBashCommand } from '../src/bash-command.js';

const cat = (cmd: string) => {
  const a = analyseBashCommand(cmd);
  return a.ok ? a.category : `refused: ${a.reason}`;
};

describe('gh is gated like a deploy program', () => {
  it('merging, releasing, changing the repository, secrets and writing API calls deploy', () => {
    expect(cat('gh pr merge 42 --squash')).toBe('deploy');
    expect(cat('gh release create v1.0.0 --notes x')).toBe('deploy');
    expect(cat('gh release delete v1.0.0')).toBe('deploy');
    expect(cat('gh repo delete acme/app --yes')).toBe('deploy');
    expect(cat('gh repo edit --visibility public')).toBe('deploy');
    expect(cat('gh secret set NPM_TOKEN')).toBe('deploy');
    expect(cat('gh variable set X')).toBe('deploy');
    expect(cat('gh api -X POST repos/acme/app/issues')).toBe('deploy');
    expect(cat('gh api --method DELETE repos/acme/app')).toBe('deploy');
    expect(cat('gh api repos/acme/app/issues -f title=x')).toBe('deploy');
    expect(cat('gh workflow run deploy.yml')).toBe('deploy');
  });
  it('reading, reviewing and commenting do not', () => {
    expect(cat('gh pr view 42 --json title')).toBe('other');
    expect(cat('gh pr diff 42')).toBe('other');
    expect(cat('gh pr checks 42')).toBe('other');
    expect(cat('gh pr review 42 --approve')).toBe('other');
    expect(cat('gh pr comment 42 --body ok')).toBe('other');
    expect(cat('gh issue list --label bug')).toBe('other');
    expect(cat('gh issue comment 12 --body done')).toBe('other');
    expect(cat('gh api repos/acme/app')).toBe('other');
    expect(cat('gh run list')).toBe('other');
  });
  it('is never run by path or with expansion', () => {
    expect(cat('/usr/bin/gh pr merge 42')).toMatch(/refused/);
    expect(cat('gh pr merge $N')).toMatch(/refused/);
  });
});
