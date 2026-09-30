import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { loadDesignSystem } from '../src/ds.js';

describe('the design system bundle', () => {
  it("loads with the app's React and exposes the components of the mockup", async () => {
    const S = await loadDesignSystem(
      pathToFileURL(join(process.cwd(), 'vendor/design-system/components/bundle.js')).href,
    );
    for (const name of [
      'Button',
      'Composer',
      'Message',
      'ToolCall',
      'NavItem',
      'AgentStatus',
      'Tabs',
      'Mascot',
      'Avatar',
      'ThinkingIndicator',
    ])
      expect(typeof (S as unknown as Record<string, unknown>)[name], name).toBe('function');
    render(<S.Button variant="primary">Run task</S.Button>);
    expect(screen.getByRole('button', { name: 'Run task' })).toBeTruthy();
    // loading twice is the same bundle, not a second copy
    expect(await loadDesignSystem()).toBe(S);
  });
});
