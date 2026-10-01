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

  it('a user message keeps its line breaks', async () => {
    const { client: c } = client({
      runs: [summary('root')],
      states: { root: state('root', { input: { spec: 'first line\nsecond line' } }) },
    });
    const ui = mount(c, { hash: '#/t/root' });
    await waitFor(() => expect(ui.container.querySelector('.sx-msg--user')).toBeTruthy());
    const user = ui.container.querySelector('.sx-msg--user') as HTMLElement;
    expect(user.textContent).toContain('second line');
    expect(user.querySelector('br')).toBeTruthy();
  });

  it('a file reported by its absolute path shows by name and opens by its workspace path', async () => {
    const { client: c, calls } = client({
      runs: [summary('root')],
      states: { root: state('root', { workspace: '/p' }) },
      frames: {
        root: [
          runFrame(1, 'NodeStarted', { nodeId: 'reply' }),
          rtFrame(1, 'reply', { type: 'file_changed', path: '/p/out/a.csv' }),
        ],
      },
    });
    mount(c, { hash: '#/t/root' });
    const chips = await screen.findAllByRole('button', { name: /a\.csv/ });
    expect(chips[0]?.textContent).not.toContain('/p/');
    fireEvent.click(chips[0] as HTMLElement);
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'fileContent')?.args).toEqual(['root', 'out/a.csv']),
    );
  });

  it('the model menu has a search field that narrows the list', async () => {
    const { client: c } = client({
      runs: [summary('root')],
      states: { root: state('root') },
    });
    mount(c, { hash: '#/t/root' });
    fireEvent.click(await screen.findByRole('button', { name: 'Change model' }));
    const menu = await screen.findByRole('menu');
    await within(menu).findByRole('menuitemradio', { name: /qwen/ }); // the models arrive on demand
    const before = within(menu).getAllByRole('menuitemradio').length;
    expect(before).toBeGreaterThan(2);
    fireEvent.change(await within(menu).findByRole('searchbox'), { target: { value: 'qwen' } });
    const after = within(menu).getAllByRole('menuitemradio');
    expect(after.length).toBeLessThan(before);
    expect(after.every((el) => /qwen/i.test(el.textContent ?? ''))).toBe(true);
    // Enter right after typing picks the first match
    fireEvent.keyDown(within(menu).getByRole('searchbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Change model' }).textContent).toContain('qwen'),
    );
  });

  it('files dropped on the conversation become chips and go with the next message as attachments', async () => {
    const { client: c, calls } = client({
      runs: [summary('root')],
      states: { root: state('root') },
    });
    mount(c, { hash: '#/t/root' });
    const box = await screen.findByRole('textbox', { name: 'Message' });
    const file = new File(['a,b\n1,2\n'], 'clientes.csv', { type: 'text/csv' });
    fireEvent.drop(screen.getByRole('main'), { dataTransfer: { files: [file], types: ['Files'] } });
    expect(await screen.findByText('clientes.csv')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'Read this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'submitRun')).toBeTruthy());
    const req = calls.find((x) => x.name === 'submitRun')?.args[0] as {
      input: string;
      attachments?: { name: string; content: string; mime?: string }[];
    };
    expect(req.input).toBe('Read this');
    expect(req.attachments).toEqual([
      { name: 'clientes.csv', content: btoa('a,b\n1,2\n'), mime: 'text/csv' },
    ]);
    expect(screen.queryByText('clientes.csv')).toBeNull(); // sent: the chips are gone
  });

  it('the Actions menu lists the org workflows; picking one makes the next message start it here', async () => {
    const { client: c, calls } = client({
      runs: [summary('root')],
      states: { root: state('root') },
    });
    mount(c, { hash: '#/t/root' });
    fireEvent.click(await screen.findByRole('button', { name: 'Actions' }));
    const menu = await screen.findByRole('menu');
    fireEvent.click(await within(menu).findByRole('menuitem', { name: /fix-issue/ }));
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    expect(box.value).toMatch(/fix-issue/);
    fireEvent.change(box, { target: { value: 'Run fix-issue: the login button is broken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'submitRun')).toBeTruthy());
    const req = calls.find((x) => x.name === 'submitRun')?.args[0] as {
      workflow: string;
      input: string;
      thread?: string;
    };
    expect(req.workflow).toBe('fix-issue');
    expect(req.input).toBe('the login button is broken');
    expect(req.thread).toBe('root');
  });

  it('the mic only shows where the browser can listen', async () => {
    const { client: c } = client({ runs: [summary('root')], states: { root: state('root') } });
    mount(c, { hash: '#/t/root' });
    await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.queryByRole('button', { name: 'Voice' })).toBeNull(); // happy-dom has no SpeechRecognition
  });

  it('a drop on the composer itself adds each file once', async () => {
    const { client: c } = client({ runs: [summary('root')], states: { root: state('root') } });
    mount(c, { hash: '#/t/root' });
    const box = await screen.findByRole('textbox', { name: 'Message' });
    const file = new File(['x'], 'one.txt', { type: 'text/plain' });
    fireEvent.drop(box, { dataTransfer: { files: [file], types: ['Files'] } });
    await screen.findByText('one.txt');
    expect(screen.getAllByText('one.txt')).toHaveLength(1);
  });

  it('a failed send keeps the text and the files', async () => {
    const { client: c } = client({
      runs: [summary('root')],
      states: { root: state('root') },
      failSubmit: true,
    });
    mount(c, { hash: '#/t/root' });
    const box = (await screen.findByRole('textbox', { name: 'Message' })) as HTMLTextAreaElement;
    fireEvent.drop(screen.getByRole('main'), {
      dataTransfer: { files: [new File(['x'], 'keep.txt')], types: ['Files'] },
    });
    await screen.findByText('keep.txt');
    fireEvent.change(box, { target: { value: 'Do not lose me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText(/refused it/)).toBeTruthy());
    expect(box.value).toBe('Do not lose me');
    expect(screen.getByText('keep.txt')).toBeTruthy();
  });

  it('a picked workflow runs as a task of the conversation, so the next message is a chat turn again', async () => {
    const { client: c, calls } = client({
      runs: [summary('root')],
      states: { root: state('root') },
    });
    mount(c, { hash: '#/t/root' });
    fireEvent.click(await screen.findByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /hello-feature/ }));
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Run hello-feature: add /health' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'submitRun')).toBeTruthy());
    const req = calls.find((x) => x.name === 'submitRun')?.args[0] as {
      workflow: string;
      parentRunId?: string;
      thread?: string;
    };
    expect(req).toMatchObject({ workflow: 'hello-feature', parentRunId: 'root', thread: 'root' });
  });

  it('too many files are refused with a notice, none of them taken', async () => {
    const { client: c } = client({ runs: [summary('root')], states: { root: state('root') } });
    mount(c, { hash: '#/t/root' });
    await screen.findByRole('textbox', { name: 'Message' });
    const files = Array.from({ length: 21 }, (_, i) => new File(['x'], `f${i}.txt`));
    fireEvent.drop(screen.getByRole('main'), { dataTransfer: { files, types: ['Files'] } });
    await waitFor(() => expect(screen.getByText(/at most 20 files/i)).toBeTruthy());
    expect(screen.queryByText('f0.txt')).toBeNull();
  });

  it('the mic stays hidden in the desktop app even when the browser engine claims speech recognition', async () => {
    const g = globalThis as { webkitSpeechRecognition?: unknown; shibaoxDesktop?: unknown };
    g.webkitSpeechRecognition = class {};
    g.shibaoxDesktop = {
      platform: 'darwin',
      saveAs: async () => ({ ok: false, reason: 'x' }),
      openWith: async () => ({ ok: false, reason: 'x' }),
      reveal: async () => {},
    };
    try {
      const { client: c } = client({ runs: [summary('root')], states: { root: state('root') } });
      mount(c, { hash: '#/t/root' });
      await screen.findByRole('textbox', { name: 'Message' });
      expect(screen.queryByRole('button', { name: 'Voice' })).toBeNull();
    } finally {
      delete g.webkitSpeechRecognition;
      delete g.shibaoxDesktop;
    }
  });
});
