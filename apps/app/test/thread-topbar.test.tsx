import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDesignSystem } from '../src/ds.js';
import { client, mount, rtFrame, runFrame, state, summary } from './fixtures.js';

beforeAll(() =>
  loadDesignSystem(
    pathToFileURL(join(process.cwd(), 'vendor/design-system/components/bundle.js')).href,
  ),
);

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

/** The direct children of the bar, as the mockup names them. */
const barShape = (top: HTMLElement) =>
  [...top.children].map((el) =>
    el.tagName === 'H2'
      ? 'title'
      : el.getAttribute('role') === 'tablist'
        ? 'tabs'
        : el.classList.contains('grow')
          ? 'space'
          : el.classList.contains('sx-popover')
            ? 'popover'
            : el.classList.contains('sx-status')
              ? 'status'
              : el.className,
  );

describe('the top bar follows the mockup', () => {
  it('holds the title, the status and the tabs only, in that order; the model lives in the composer', async () => {
    const { client: c } = client({ runs: [summary('root')], states: { root: state('root') } });
    const ui = mount(c, { hash: '#/t/root' });
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
    const top = ui.container.querySelector('.top') as HTMLElement;
    expect(top.querySelector('h2')?.textContent).toBe('Find me a hotel in Porto');
    expect(barShape(top)).toEqual(['title', 'status', 'space', 'tabs']);
    expect(top.querySelector('select')).toBeNull();
    expect(within(top).queryByText(/Model/)).toBeNull();
    // the composer's model label is the way to change it
    const change = screen.getByRole('button', { name: 'Change model' });
    expect(change.textContent).toContain('claude-opus');
  });

  it('the model menu opens from the composer and sets the model of the next turn', async () => {
    const { client: c, calls } = client({
      runs: [summary('root')],
      states: { root: state('root') },
    });
    mount(c, { hash: '#/t/root' });
    fireEvent.click(await screen.findByRole('button', { name: 'Change model' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: /The org's tiers/ })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /qwen/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Change model' }).textContent).toContain('qwen'),
    );
    expect(screen.queryByRole('menu')).toBeNull();
    // the keyboard is not lost: focus is back on the button the menu came from
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change model' }));
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'again' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'submitRun')?.args[0]).toMatchObject({
        model: 'lmstudio/qwen',
      }),
    );
  });

  it('Steer is an icon button whose note opens in a popover, never inside the bar', async () => {
    const { client: c, calls } = client({
      runs: [summary('root', { status: 'running' })],
      states: { root: state('root', { status: 'running' }) },
      frames: {
        root: [
          runFrame(1, 'NodeStarted', { nodeId: 'reply' }),
          rtFrame(1, 'reply', { type: 'text', text: 'Working…' }),
        ],
      },
    });
    const ui = mount(c, { hash: '#/t/root' });
    const steer = await screen.findByRole('button', { name: 'Steer' });
    const top = ui.container.querySelector('.top') as HTMLElement;
    expect(barShape(top)).toEqual(['title', 'status', 'space', 'popover', 'tabs']);
    expect(top.querySelector('input')).toBeNull();
    fireEvent.click(steer);
    const dialog = await screen.findByRole('dialog');
    // the form floats: the bar's own row has no field, and its shape did not change
    expect(barShape(top)).toEqual(['title', 'status', 'space', 'popover', 'tabs']);
    expect(top.querySelector(':scope > form, :scope > input')).toBeNull();
    const note = within(dialog).getByPlaceholderText('A note for the running task');
    fireEvent.change(note, { target: { value: 'use pnpm' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send note' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'steer')?.args).toEqual(['root', { note: 'use pnpm' }]),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(top.querySelector('h2')).toBeTruthy();
  });

  it('the menu opens on the checked item and Enter picks it', async () => {
    const { client: c } = client({ runs: [summary('root')], states: { root: state('root') } });
    mount(c, { hash: '#/t/root' });
    fireEvent.click(await screen.findByRole('button', { name: 'Change model' }));
    const menu = await screen.findByRole('menu');
    expect(menu.classList.contains('sx-menu')).toBe(true);
    await waitFor(() =>
      expect(within(menu).getAllByRole('menuitemradio').length).toBeGreaterThan(1),
    );
    const active = menu.querySelector('.sx-menu__item.is-active') as HTMLElement;
    expect(active.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('opening another conversation starts at its end, with no stale "Jump to latest"', async () => {
    const { client: c } = client({
      runs: [summary('root'), summary('other')],
      states: { root: state('root'), other: state('other') },
      frames: {
        root: [
          runFrame(1, 'NodeStarted', { nodeId: 'reply' }),
          rtFrame(1, 'reply', { type: 'text', text: 'A long reply.' }),
        ],
        other: [
          runFrame(1, 'NodeStarted', { nodeId: 'reply' }),
          rtFrame(1, 'reply', { type: 'text', text: 'Another reply.' }),
        ],
      },
    });
    const ui = mount(c, { hash: '#/t/root' });
    await waitFor(() => expect(screen.getByText('A long reply.')).toBeTruthy());
    const box = ui.container.querySelector('.scroll') as HTMLElement;
    box.scrollTop = 100;
    fireEvent.scroll(box);
    act(() => {
      window.location.hash = '#/t/other';
      window.dispatchEvent(new Event('hashchange'));
    });
    await waitFor(() => expect(screen.getByText('Another reply.')).toBeTruthy());
    const box2 = ui.container.querySelector('.scroll') as HTMLElement;
    expect(box2.scrollTop).toBe(1000);
    expect(screen.queryByText('Jump to latest')).toBeNull();
  });

  it('the conversation scrolls as a whole column, with the thread centred inside', async () => {
    const { client: c } = client({ runs: [summary('root')], states: { root: state('root') } });
    const ui = mount(c, { hash: '#/t/root' });
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
    const scroll = ui.container.querySelector('.main > .scroll') as HTMLElement;
    expect(scroll).toBeTruthy();
    expect(scroll.querySelector('.thread')).toBeTruthy();
  });
});

describe('the reply is rendered as a document', () => {
  it('text, a tool call and more text keep their order; fences become code blocks', async () => {
    const { client: c } = client({
      runs: [summary('root')],
      states: { root: state('root') },
      frames: {
        root: [
          runFrame(1, 'NodeStarted', { nodeId: 'reply' }),
          rtFrame(1, 'reply', { type: 'text', text: 'Looking.' }),
          rtFrame(2, 'reply', {
            type: 'tool_use',
            id: 'u1',
            name: 'read_file',
            input: { path: 'a.ts' },
          }),
          rtFrame(3, 'reply', { type: 'tool_result', id: 'u1', output: 'x' }),
          rtFrame(4, 'reply', { type: 'text', text: 'Here:\n\n```js\nlet a = 1;\n```\n' }),
        ],
      },
    });
    const ui = mount(c, { hash: '#/t/root' });
    await waitFor(() => expect(ui.container.querySelector('.sx-code')).toBeTruthy());
    const body = ui.container.querySelector('.sx-msg--agent .sx-msg__body') as HTMLElement;
    const order = [...body.querySelectorAll('p, .sx-tool, .sx-code')].map((el) =>
      el.classList.contains('sx-tool')
        ? 'tool'
        : el.classList.contains('sx-code')
          ? 'code'
          : el.textContent,
    );
    expect(order).toEqual(['Looking.', 'tool', 'Here:', 'code']);
    expect(body.textContent).not.toContain('```');
  });

  it('a file the run wrote is a chip in the message and in the Outputs row; clicking opens it in the sheet', async () => {
    const { client: c, calls } = client({
      runs: [summary('root')],
      states: { root: state('root') },
      frames: {
        root: [
          runFrame(1, 'NodeStarted', { nodeId: 'reply' }),
          rtFrame(1, 'reply', { type: 'text', text: 'Saved it.' }),
          rtFrame(2, 'reply', { type: 'file_changed', path: 'out/clientes.csv' }),
        ],
      },
    });
    const ui = mount(c, { hash: '#/t/root' });
    const chips = await screen.findAllByRole('button', { name: /clientes\.csv/ });
    expect(chips.length).toBe(2); // the message and the Outputs row
    expect(ui.container.querySelector('.outputs')?.textContent).toContain('Outputs · 1');
    fireEvent.click(chips[1] as HTMLElement);
    const sheet = await screen.findByRole('dialog', { name: 'clientes.csv' });
    await waitFor(() => expect(sheet.textContent).toContain('name'));
    expect(calls.find((x) => x.name === 'fileContent')?.args).toEqual(['root', 'out/clientes.csv']);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'fileBlob')).toBeTruthy());
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'clientes.csv' })).toBeNull();
  });
});
