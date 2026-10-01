import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RoutineView } from '@wizardingcode/shibaox-daemon';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDesignSystem } from '../src/ds.js';
import { client, mount } from './fixtures.js';

beforeAll(() =>
  loadDesignSystem(
    pathToFileURL(join(process.cwd(), 'vendor/design-system/components/bundle.js')).href,
  ),
);

const view = (o: Partial<RoutineView>): RoutineView =>
  ({
    id: 'scan',
    name: 'Weekly scan',
    description: 'Audit the dependencies',
    trigger: { type: 'cron', cron: '0 9 * * 1' },
    orgRoot: '/o',
    project: '/p',
    workflow: 'security-scan',
    input: 'Run the audit and report',
    mode: 'always',
    intervalS: 120,
    enabled: true,
    source: 'org',
    createdAt: '2026-09-30T10:00:00.000Z',
    nextRunAt: '2026-10-06T09:00:00.000Z',
    words: 'Every Monday at 09:00',
    ...o,
  }) as RoutineView;

const open = async (name: string) => {
  fireEvent.click(await screen.findByRole('button', { name: 'New routine' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(name) }));
};

describe('Scheduled', () => {
  it('lists routines as cards with words, next run, last run and badges; search and sort', async () => {
    const { client: c } = client({
      routines: [
        view({}),
        view({
          id: 'brief',
          name: 'Daily briefing',
          trigger: { type: 'cron', cron: '0 9 * * 1-5' },
          words: 'Weekdays at 09:00',
          nextRunAt: '2026-10-02T09:00:00.000Z',
          source: 'api',
          approvals: 'auto',
          lastRun: {
            runId: 'r9',
            status: 'completed',
            spentUsd: 0.12,
            createdAt: '2026-10-01T09:00:00.000Z',
          },
        }),
        view({ id: 'off', name: 'Paused one', enabled: false, nextRunAt: null }),
      ],
    });
    const ui = mount(c, { hash: '#/scheduled' });
    await waitFor(() => expect(screen.getByText('Weekly scan')).toBeTruthy());
    const cards = () =>
      [...ui.container.querySelectorAll('.sx-card')].map(
        (c) => c.querySelector('.sx-card__title')?.textContent,
      );
    // by next run: the briefing (tomorrow) first, the paused one last
    expect(cards()).toEqual(['Daily briefing', 'Weekly scan', 'Paused one']);
    const brief = screen.getByText('Daily briefing').closest('.sx-card') as HTMLElement;
    expect(brief.textContent).toContain('Weekdays at 09:00');
    expect(brief.textContent).toContain('Auto approvals');
    expect(brief.textContent).toMatch(/Last run/);
    expect(brief.textContent).toContain('$0.12');
    expect(
      within(screen.getByText('Paused one').closest('.sx-card') as HTMLElement).getByText('Paused'),
    ).toBeTruthy();
    expect(
      within(screen.getByText('Weekly scan').closest('.sx-card') as HTMLElement).getByText(
        'from the org',
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search routines' }), {
      target: { value: 'brief' },
    });
    expect(cards()).toEqual(['Daily briefing']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search routines' }), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Sort by/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Name/ }));
    expect(cards()).toEqual(['Daily briefing', 'Paused one', 'Weekly scan']);
  });

  it('the card menu runs, pauses, edits and removes (after a confirmation)', async () => {
    const { client: c, calls } = client({ routines: [view({ source: 'api' })] });
    mount(c, { hash: '#/scheduled' });
    await screen.findByText('Weekly scan');
    const actions = () => screen.getByRole('button', { name: 'Actions for Weekly scan' });
    fireEvent.click(actions());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run now' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'runRoutine')?.args[0]).toBe('scan'));
    fireEvent.click(actions());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pause' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'pauseRoutine')?.args[0]).toBe('scan'));
    fireEvent.click(actions());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove routine?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'removeRoutine')?.args[0]).toBe('scan'),
    );
    fireEvent.click(actions());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit routine' });
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Weekly scan');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Weekly audit' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'updateRoutine')?.args).toEqual([
        'scan',
        expect.objectContaining({ name: 'Weekly audit' }),
      ]),
    );
  });

  it('Set up manually: name, instructions, a frequency preset, permissions with a warning, advanced settings', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/scheduled' });
    await open('Set up manually');
    const dialog = await screen.findByRole('dialog', { name: 'Create routine' });
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Daily briefing' },
    });
    fireEvent.change(within(dialog).getByLabelText('Instructions'), {
      target: { value: "Summarise yesterday's commits." },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Frequency' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Weekdays at/ }));
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '09:30' } });
    expect(dialog.textContent).toContain('Weekdays at 09:30');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Permissions' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Automatically approve/ }));
    expect(dialog.textContent).toMatch(/without asking/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Advanced settings' }));
    fireEvent.change(within(dialog).getByLabelText('Budget per run (USD)'), {
      target: { value: '1.5' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'addRoutine')?.args[0]).toMatchObject({
        name: 'Daily briefing',
        input: "Summarise yesterday's commits.",
        trigger: { type: 'cron', cron: '30 9 * * 1-5' },
        approvals: 'auto',
        budgetUsd: 1.5,
        workflow: 'chat',
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Create routine' })).toBeNull();
  });

  it('a GitHub frequency takes what to watch, the repository and a label', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/scheduled' });
    await open('Set up manually');
    const dialog = await screen.findByRole('dialog', { name: 'Create routine' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Bugs' } });
    fireEvent.change(within(dialog).getByLabelText('Instructions'), {
      target: { value: 'Fix it' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Frequency' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /GitHub issues/ }));
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'bug' } });
    fireEvent.change(within(dialog).getByLabelText('Repository'), { target: { value: 'wc/app' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((x) => x.name === 'addRoutine')?.args[0]).toMatchObject({
        trigger: { type: 'github', watch: 'issues', label: 'bug', repo: 'wc/app' },
      }),
    );
  });

  it('a template prefills the dialog; Create with Shibaox drafts it from a sentence', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/scheduled' });
    await open('From a template');
    fireEvent.click(await screen.findByRole('button', { name: /Security scan/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Create routine' });
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Security scan');
    expect(dialog.textContent).toContain('Every Monday at 09:00');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await open('Create with Shibaox');
    const ask = await screen.findByRole('dialog', { name: 'Create with Shibaox' });
    fireEvent.change(within(ask).getByLabelText('Describe what to watch and what to do'), {
      target: { value: 'every weekday at 9 tell me what changed' },
    });
    fireEvent.click(within(ask).getByRole('button', { name: 'Draft it' }));
    const drafted = await screen.findByRole('dialog', { name: 'Create routine' });
    await waitFor(() =>
      expect((within(drafted).getByLabelText('Name') as HTMLInputElement).value).toBe(
        'Daily briefing',
      ),
    );
    expect(calls.find((x) => x.name === 'draftRoutine')?.args[0]).toMatchObject({
      text: 'every weekday at 9 tell me what changed',
    });
    expect(drafted.textContent).toContain('Weekdays at 09:00');
  });

  it('editing back to the org tiers clears the model; a cron turned watcher leaves the mode to the daemon', async () => {
    const { client: c, calls } = client({
      routines: [view({ source: 'api', model: 'openai/gpt-5', description: 'd' })],
    });
    mount(c, { hash: '#/scheduled' });
    await screen.findByText('Weekly scan');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Weekly scan' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit routine' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Model' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /org's tiers/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Frequency' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /GitHub issues/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((x) => x.name === 'updateRoutine')).toBeTruthy());
    const patch = calls.find((x) => x.name === 'updateRoutine')?.args[1] as Record<string, unknown>;
    expect(patch.model).toBeNull();
    expect(patch.trigger).toEqual({ type: 'github', watch: 'issues' });
    expect(patch.mode).toBeUndefined();
    expect(patch.maxDailyUsd).toBeUndefined();
  });

  it('Save stays off while a watcher has nothing to watch', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/scheduled' });
    await open('Set up manually');
    const dialog = await screen.findByRole('dialog', { name: 'Create routine' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Page' } });
    fireEvent.change(within(dialog).getByLabelText('Instructions'), {
      target: { value: 'Tell me' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Frequency' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /page changes/ }));
    expect(
      (within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('URL'), {
      target: { value: 'https://example.com' },
    });
    expect(
      (within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
