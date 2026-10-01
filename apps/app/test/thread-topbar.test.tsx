import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDesignSystem } from '../src/ds.js';
import { client, mount, rtFrame, runFrame, state, summary } from './fixtures.js';

beforeAll(() =>
  loadDesignSystem(
    pathToFileURL(join(process.cwd(), 'vendor/design-system/components/bundle.js')).href,
  ),
);

describe('the top bar follows the mockup', () => {
  it('holds the title, the status and the tabs only; the model lives in the composer', async () => {
    const { client: c } = client({ runs: [summary('root')], states: { root: state('root') } });
    const ui = mount(c, { hash: '#/t/root' });
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
    const top = ui.container.querySelector('.top') as HTMLElement;
    expect(top.querySelector('h2')?.textContent).toBe('Find me a hotel in Porto');
    expect(top.querySelector('[role=tablist]')).toBeTruthy();
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
    expect(top.contains(steer)).toBe(true);
    expect(top.querySelector('input')).toBeNull();
    fireEvent.click(steer);
    const dialog = await screen.findByRole('dialog');
    const note = within(dialog).getByPlaceholderText('A note for the running task');
    fireEvent.change(note, { target: { value: 'use pnpm' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send note' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'steer')?.args).toEqual(['root', { note: 'use pnpm' }]),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(top.querySelector('h2')).toBeTruthy();
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
