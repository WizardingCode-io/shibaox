import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { InboxItem } from '@wizardingcode/shibaox-daemon';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDesignSystem } from '../src/ds.js';
import { client, mount, rtFrame, runFrame, state, summary } from './fixtures.js';

beforeAll(() =>
  loadDesignSystem(
    pathToFileURL(join(process.cwd(), 'vendor/design-system/components/bundle.js')).href,
  ),
);

describe('the app', () => {
  it('renders the mockup: brand, New chat, the five sections, the recent threads and the me row', async () => {
    const { client: c } = client({
      runs: [
        summary('root'),
        summary('other', {
          createdAt: '2026-09-30T09:00:00.000Z',
          updatedAt: '2026-09-30T09:00:10.000Z',
        }),
      ],
      states: {
        root: state('root'),
        other: state('other', { input: { spec: 'Weekly invoices' } }),
      },
    });
    mount(c);
    const side = screen.getByRole('complementary');
    expect(within(side).getByText('shibaox')).toBeTruthy();
    expect(within(side).getByRole('button', { name: 'New chat' })).toBeTruthy();
    for (const label of ['Chats', 'Scheduled', 'Skills', 'Memory', 'Integrations'])
      expect(within(side).getByText(label)).toBeTruthy();
    expect(within(side).getByText('Recent')).toBeTruthy();
    await waitFor(() => expect(within(side).getByText('Find me a hotel in Porto')).toBeTruthy());
    expect(within(side).getByRole('button', { name: 'Settings' })).toBeTruthy();
  });
  it('a thread: title, status, tabs, the conversation, and a tool call that needs approval with Approve calling the inbox', async () => {
    const st = state('root', {
      status: 'running',
      pendingApprovals: [
        {
          approvalId: 'a1',
          runId: 'root',
          nodeId: 'reply',
          role: 'assistant',
          tool: 'Bash',
          program: 'git',
          category: 'push',
          command: 'git push origin main',
          argvHash: 'h',
          at: 't',
        },
      ],
    } as never);
    const frames = [
      runFrame(1, 'NodeStarted', { nodeId: 'reply' }),
      rtFrame(1, 'reply', { type: 'text', text: 'On it. I compared 24 hotels.' }),
      rtFrame(2, 'reply', {
        type: 'tool_use',
        id: 'u1',
        name: 'browser.search',
        input: { q: 'hotels' },
      }),
      rtFrame(3, 'reply', {
        type: 'tool_result',
        id: 'u1',
        name: 'browser.search',
        output: { hits: 24 },
        durationMs: 3100,
      }),
    ];
    const inbox: InboxItem[] = [
      {
        id: 'approval:a1',
        kind: 'approval',
        runId: 'root',
        nodeId: 'reply',
        at: 't',
        prompt: 'git push origin main',
        detail: { role: 'assistant', program: 'git', category: 'push', tool: 'Bash' },
      },
    ];
    const { client: c, calls } = client({
      runs: [summary('root', { status: 'running' })],
      states: { root: st },
      frames: { root: frames },
      inbox,
    });
    mount(c, { hash: '#/t/root' });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Find me a hotel in Porto' })).toBeTruthy(),
    );
    expect(screen.getByText('Needs you')).toBeTruthy();
    for (const tab of ['Chat', 'Tasks', 'Logs'])
      expect(screen.getByRole('tab', { name: new RegExp(`^${tab}`) })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('On it. I compared 24 hotels.')).toBeTruthy());
    expect(screen.getByText('browser.search')).toBeTruthy();
    expect(screen.getByText('git push origin main')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'answer')?.args).toEqual([
        'approval:a1',
        { approved: true },
      ]),
    );
  });
  it('sending from the composer submits the next turn of the thread; Stop cancels the live turn', async () => {
    const { client: c, calls } = client({
      runs: [summary('root')],
      states: { root: state('root') },
      frames: {
        root: [
          runFrame(1, 'NodeStarted', { nodeId: 'reply' }),
          rtFrame(1, 'reply', { type: 'text', text: 'Done.' }),
        ],
      },
    });
    mount(c, { hash: '#/t/root' });
    await waitFor(() => expect(screen.getByText('Done.')).toBeTruthy());
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'Book the first one' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'submitRun')?.args[0]).toMatchObject({
        input: 'Book the first one',
        thread: 'root',
        workflow: 'chat',
      }),
    );
  });
  it('without a connection, Connect asks for the daemon and keeps it', async () => {
    const { client: c } = client();
    const ui = mount(c, { connected: false });
    expect(screen.getByRole('heading', { name: 'Connect to your daemon' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Daemon URL'), { target: { value: 'http://vps:7433' } });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByRole('complementary')).toBeTruthy());
    ui.unmount();
  });
  it('settings: the theme choice lands on the document and is kept', async () => {
    const { client: c } = client();
    const { store } = mount(c, { hash: '#/settings' });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Dark' }));
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(store.get().settings.theme).toBe('dark');
  });
});

describe('the app: the review fixes', () => {
  it('an approval raised inside a dispatched run shows in the chat and on its task card', async () => {
    const child = state('child', {
      status: 'running',
      thread: 'root',
      parentRunId: 'root',
      workflow: 'hello-feature',
      input: { spec: 'build' },
    } as never);
    const inbox: InboxItem[] = [
      {
        id: 'approval:c1',
        kind: 'approval',
        runId: 'child',
        nodeId: 'implement',
        at: 't',
        prompt: 'git push origin main',
        detail: { role: 'backend', program: 'git', category: 'push', tool: 'Bash' },
      },
    ];
    const { client: c, calls } = client({
      runs: [
        summary('root'),
        summary('child', {
          thread: 'root',
          parentRunId: 'root',
          workflow: 'hello-feature',
          status: 'running',
        }),
      ],
      states: { root: state('root', { input: { spec: 'Ship it' } }), child },
      frames: {
        root: [
          runFrame(1, 'NodeStarted', { nodeId: 'reply' }),
          rtFrame(1, 'reply', { type: 'text', text: 'Dispatching.' }),
        ],
      },
      inbox,
    });
    mount(c, { hash: '#/t/root' });
    await waitFor(() => expect(screen.getByText('git push origin main')).toBeTruthy());
    expect(screen.getByText('Needs you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'answer')?.args[0]).toBe('approval:c1'),
    );
    fireEvent.click(screen.getByRole('tab', { name: /^Tasks/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Steer' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  });
  it('a paused turn offers Resume with a budget', async () => {
    const { client: c, calls } = client({
      runs: [summary('root', { status: 'paused_budget' })],
      states: { root: state('root', { status: 'paused_budget' }) },
    });
    mount(c, { hash: '#/t/root' });
    fireEvent.click(await screen.findByRole('button', { name: 'Resume with a budget' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'resume')?.args[0]).toBe('root'));
  });
  it('Open audit fetches the document with the token instead of navigating to a URL', async () => {
    const { client: c, calls } = client({
      runs: [summary('root')],
      states: { root: state('root') },
    });
    const opened: string[] = [];
    window.open = ((u: string) => {
      opened.push(String(u));
      return null;
    }) as never;
    (globalThis.URL as unknown as { createObjectURL?: unknown }).createObjectURL ??= () =>
      'blob:audit';
    mount(c, { hash: '#/t/root' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Logs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /^Logs/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open audit' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'auditMarkdown')?.args[0]).toBe('root'),
    );
    await waitFor(() => expect(opened[0]).toMatch(/^blob:/));
  });
  it('a wrong token brings the Connect screen back with a word about it', async () => {
    const { client: c } = client();
    const bad = {
      ...c,
      listRuns: async () => {
        throw Object.assign(new Error('the bearer token is wrong'), {
          status: 401,
          name: 'AppHttpError',
        });
      },
    };
    mount(bad);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Connect to your daemon' })).toBeTruthy(),
    );
    expect(screen.getByText(/refused the token/)).toBeTruthy();
  });
});

describe('the sections', () => {
  const routine = {
    id: 'scan',
    name: 'Weekly scan',
    trigger: { type: 'cron', cron: '0 9 * * 1' },
    orgRoot: '/o',
    project: '/p',
    workflow: 'security-scan',
    input: 'x',
    mode: 'always',
    intervalS: 120,
    enabled: true,
    source: 'org',
    createdAt: 't',
    lastFiredAt: '2026-09-30T09:00:00.000Z',
  };
  it('Scheduled lists the routines with Run now, Pause and Sync from org; Add routine posts one', async () => {
    const { client: c, calls } = client({ routines: [routine] });
    mount(c, { hash: '#/scheduled' });
    await waitFor(() => expect(screen.getByText('Weekly scan')).toBeTruthy());
    expect(screen.getByText(/security-scan/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'runRoutine')?.args[0]).toBe('scan'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'pauseRoutine')?.args[0]).toBe('scan'));
    fireEvent.click(screen.getByRole('button', { name: 'Sync from org' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'syncRoutines')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add routine' }));
    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'url' } });
    fireEvent.change(screen.getByLabelText('Watch'), {
      target: { value: 'https://example.com/status' },
    });
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'hello-feature' } });
    fireEvent.change(screen.getByLabelText('Request'), { target: { value: 'Check it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save routine' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'addRoutine')?.args[0]).toMatchObject({
        trigger: { type: 'url', url: 'https://example.com/status' },
        workflow: 'hello-feature',
        input: 'Check it',
      }),
    );
  });
  it('Skills lists the workflows and runs one as a task', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/skills' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run task' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    fireEvent.change(screen.getByLabelText('Request'), { target: { value: 'Add a footer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'submitRun')?.args[0]).toMatchObject({
        workflow: 'chat',
        input: 'Add a footer',
      }),
    );
  });
  it('Memory shows the project profile and the org', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/memory' });
    await waitFor(() => expect(screen.getByText('sample')).toBeTruthy());
    expect(screen.getByText(/main/)).toBeTruthy();
    expect(screen.getByText(/pnpm test/)).toBeTruthy();
    expect(screen.getByText(/claude-opus/)).toBeTruthy();
  });
  it('Integrations: MCP with Test, models, keys with Set/Unset, tiers with Save', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/integrations' });
    await waitFor(() => expect(screen.getByText('playwright')).toBeTruthy());
    expect(screen.getByText(/PW_TOKEN/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(screen.getByText(/browser_navigate/)).toBeTruthy());
    expect(screen.getByText('lmstudio/qwen')).toBeTruthy();
    expect(screen.getAllByText(/OPENAI_API_KEY/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('OPENAI_API_KEY'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Set' })[0] as HTMLElement);
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'setKey')?.args).toEqual(['OPENAI_API_KEY', 'sk-new']),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unset' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'unsetKey')?.args[0]).toBe('GH_TOKEN'));
    fireEvent.change(screen.getByLabelText('Cheap'), { target: { value: 'openai/gpt-5-nano' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'setOrgConfig')?.args[1]).toMatchObject({
        tiers: { cheap: 'openai/gpt-5-nano' },
      }),
    );
  });
  it('a conversation can pick its model for the next turns', async () => {
    const { client: c, calls } = client({
      runs: [summary('root')],
      states: { root: state('root') },
    });
    mount(c, { hash: '#/t/root' });
    fireEvent.click(await screen.findByRole('button', { name: 'Change model' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /qwen/ }));
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'again' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'submitRun')?.args[0]).toMatchObject({
        model: 'lmstudio/qwen',
      }),
    );
  });
});

describe('the sections: the review fixes', () => {
  it('a GitHub routine takes what to watch and the optional repo, label and branch', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/scheduled' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add routine' }));
    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'github' } });
    fireEvent.change(await screen.findByLabelText('What to watch'), { target: { value: 'prs' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'bug' } });
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'wc/app' } });
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'review-pr' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save routine' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'addRoutine')?.args[0]).toMatchObject({
        trigger: { type: 'github', watch: 'prs', label: 'bug', repo: 'wc/app' },
        workflow: 'review-pr',
      }),
    );
  });
  it('the composer shows the model picked for the conversation', async () => {
    const { client: c } = client({ runs: [summary('root')], states: { root: state('root') } });
    mount(c, { hash: '#/t/root' });
    fireEvent.click(await screen.findByRole('button', { name: 'Change model' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /qwen/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Change model' }).textContent).toContain('qwen'),
    );
  });
});
