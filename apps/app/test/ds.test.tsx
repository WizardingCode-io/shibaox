import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { loadDesignSystem } from '../src/ds.js';

const load = () =>
  loadDesignSystem(
    pathToFileURL(join(process.cwd(), 'vendor/design-system/components/bundle.js')).href,
  );

describe('the design system bundle', () => {
  it("loads with the app's React and exposes the components of the mockup", async () => {
    const S = await load();
    for (const name of [
      'Button',
      'Composer',
      'Message',
      'ToolCall',
      'NavItem',
      'AgentStatus',
      'Tabs',
      'Segmented',
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

describe('the design system: Customize additions', () => {
  it('Segmented is a radiogroup that moves with the arrows and shows a dot', async () => {
    const S = await load();
    const seen: string[] = [];
    const Demo = () => {
      const [v, setV] = useState('yours');
      return (
        <S.Segmented
          label="Show"
          items={[
            { id: 'yours', label: 'Yours', dot: true },
            { id: 'discover', label: 'Discover' },
          ]}
          value={v}
          onChange={(id) => {
            seen.push(id);
            setV(id);
          }}
        />
      );
    };
    render(<Demo />);
    const group = screen.getByRole('radiogroup', { name: 'Show' });
    const yours = within(group).getByRole('radio', { name: 'Yours' });
    const discover = within(group).getByRole('radio', { name: 'Discover' });
    expect(yours.getAttribute('aria-checked')).toBe('true');
    expect(yours.getAttribute('tabindex')).toBe('0');
    expect(discover.getAttribute('tabindex')).toBe('-1');
    expect(yours.querySelector('.sx-seg__dot')).toBeTruthy();
    expect(discover.querySelector('.sx-seg__dot')).toBeNull();
    fireEvent.keyDown(yours, { key: 'ArrowRight' });
    expect(seen).toEqual(['discover']);
    expect(
      within(group).getByRole('radio', { name: 'Discover' }).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.keyDown(within(group).getByRole('radio', { name: 'Discover' }), { key: 'ArrowLeft' });
    expect(seen).toEqual(['discover', 'yours']);
    fireEvent.click(within(group).getByRole('radio', { name: 'Discover' }));
    expect(seen).toEqual(['discover', 'yours', 'discover']);
  });

  it('Card renders meta under the description and aside on the right; the old props still work', async () => {
    const S = await load();
    const { container } = render(
      <S.Card
        icon="plug"
        title="github"
        description="Issues and pull requests"
        meta={<span>by GitHub</span>}
        aside={<button type="button">Add</button>}
        action={<span>act</span>}
        footer={<span>foot</span>}
      />,
    );
    expect(container.querySelector('.sx-card__meta')?.textContent).toBe('by GitHub');
    expect(container.querySelector('.sx-card__aside button')?.textContent).toBe('Add');
    expect(container.querySelector('.sx-card__action')?.textContent).toBe('act');
    expect(container.querySelector('.sx-card__foot')?.textContent).toBe('foot');
    expect(container.querySelector('.sx-card__desc')?.textContent).toBe('Issues and pull requests');
  });

  it('draws the new icons', async () => {
    const S = await load();
    const names = [
      'puzzle',
      'key',
      'lock',
      'package',
      'trash',
      'sparkles',
      'server',
      'github',
      'filter',
      'more-horizontal',
      'arrow-up-down',
      'check-circle',
    ] as const;
    const { container } = render(
      <div>
        {names.map((n) => (
          <S.Icon key={n} name={n} label={n} />
        ))}
      </div>,
    );
    for (const n of names) {
      const svg = container.querySelector(`svg[aria-label="${n}"]`);
      expect(svg, n).toBeTruthy();
      expect(svg?.innerHTML.length ?? 0, n).toBeGreaterThan(10);
    }
  });
});
