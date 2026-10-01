import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useFollowScroll } from '../src/hooks/follow-scroll.js';

// happy-dom has no layout: every element is 300 px tall with 1000 px of content
const sizes = { scrollHeight: 1000, clientHeight: 300 };
const saved: Record<string, PropertyDescriptor | undefined> = {};
beforeAll(() => {
  for (const k of Object.keys(sizes) as (keyof typeof sizes)[]) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => sizes[k] });
  }
});
afterAll(() => {
  for (const k of Object.keys(sizes)) {
    const d = saved[k];
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

function Probe(props: { version: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const f = useFollowScroll(ref, props.version);
  return (
    <div>
      <div data-testid="box" ref={ref} />
      {f.behind ? (
        <button type="button" onClick={f.jump}>
          Jump to latest
        </button>
      ) : null}
      <span data-testid="following">{String(f.following)}</span>
    </div>
  );
}

describe('useFollowScroll', () => {
  it('starts at the bottom and keeps following new content until the user scrolls up', () => {
    const ui = render(<Probe version={1} />);
    const box = screen.getByTestId('box');
    expect(box.scrollTop).toBe(1000);
    expect(screen.getByTestId('following').textContent).toBe('true');
    box.scrollTop = 400; // the browser grows the content: still at the bottom from our side
    ui.rerender(<Probe version={2} />);
    expect(box.scrollTop).toBe(1000);
    // the user scrolls up
    box.scrollTop = 100;
    fireEvent.scroll(box);
    expect(screen.getByTestId('following').textContent).toBe('false');
    expect(screen.queryByText('Jump to latest')).toBeNull();
    // new content arrives: the view stays put and offers to jump
    ui.rerender(<Probe version={3} />);
    expect(box.scrollTop).toBe(100);
    expect(screen.getByText('Jump to latest')).toBeTruthy();
    fireEvent.click(screen.getByText('Jump to latest'));
    expect(box.scrollTop).toBe(1000);
    expect(screen.getByTestId('following').textContent).toBe('true');
    expect(screen.queryByText('Jump to latest')).toBeNull();
  });

  it('scrolling back near the bottom by hand resumes following', () => {
    render(<Probe version={1} />);
    const box = screen.getByTestId('box');
    box.scrollTop = 100;
    fireEvent.scroll(box);
    expect(screen.getByTestId('following').textContent).toBe('false');
    box.scrollTop = 1000 - 300 - 20; // within 48 px of the end
    fireEvent.scroll(box);
    expect(screen.getByTestId('following').textContent).toBe('true');
  });
});
