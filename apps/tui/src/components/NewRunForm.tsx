import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SubmitRequest } from '@shibaox/daemon';
import { loadOrg as loadOrgDefault } from '@shibaox/schemas';
import { Box, Text, useInput } from 'ink';
import { useEffect, useReducer, useRef, useState } from 'react';
import { loadPrefs, savePrefs } from '../prefs.js';
import { colors } from '../theme.js';

export interface NewRunFormProps {
  /** Working directory: `./org` here is the default org when it exists. */
  cwd: string;
  /** Where `ui.json` lives (the shibaox home). */
  home: string;
  env: NodeJS.ProcessEnv;
  onSubmit: (req: SubmitRequest) => Promise<string | undefined>;
  onCancel: () => void;
  onDone: (runId: string) => void;
  /** Debounce for reloading the org while typing its path (default 300 ms). */
  debounceMs?: number;
  loadOrg?: typeof loadOrgDefault;
}

const FIELDS = ['org', 'project', 'workflow', 'input', 'adapter', 'workspace', 'budget'] as const;
type Field = (typeof FIELDS)[number];
const ADAPTERS = ['mock', 'direct', 'claude-code'] as const;
const WORKSPACES = ['auto', 'inplace', 'worktree'] as const;
const CHOICE_FIELDS: readonly Field[] = ['workflow', 'adapter', 'workspace'];
const TEXT_FIELDS = ['org', 'project', 'input', 'budget'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

interface Form {
  org: string;
  project: string;
  workflow: string;
  input: string;
  adapter: string;
  workspace: string;
  budget: string;
  field: Field;
  workflows: string[];
  orgError?: string;
  error?: string;
  busy: boolean;
  adapterTouched: boolean;
}

const cycle = <T,>(list: readonly T[], current: T, delta: 1 | -1): T => {
  const i = list.indexOf(current);
  return list[(Math.max(0, i) + delta + list.length) % list.length] as T;
};

/**
 * The form behind `N`: org, project, workflow (from the org), input, adapter, workspace,
 * budget. The form state lives in a ref mutated synchronously by the key handler (keys can
 * arrive faster than React re-renders); a counter triggers the renders.
 */
export function NewRunForm(props: NewRunFormProps) {
  const { cwd, home, onSubmit, onCancel, onDone } = props;
  const loadOrg = props.loadOrg ?? loadOrgDefault;
  const debounceMs = props.debounceMs ?? 300;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const form = useRef<Form>(null as unknown as Form);
  if (form.current === null) {
    const prefs = loadPrefs(home);
    form.current = {
      org: existsSync(join(cwd, 'org')) ? join(cwd, 'org') : (prefs.lastOrg ?? ''),
      project: prefs.lastProject ?? cwd,
      workflow: '',
      input: '',
      adapter: prefs.lastAdapter ?? 'mock',
      workspace: prefs.lastWorkspace ?? 'auto',
      budget: '',
      field: 'org',
      workflows: [],
      busy: false,
      adapterTouched: prefs.lastAdapter !== undefined,
    };
  }
  const f = form.current;
  const [orgPath, setOrgPath] = useState(f.org);
  const update = (patch: Partial<Form>) => {
    Object.assign(f, patch);
    rerender();
  };

  // reload the org when its path settles; the latest closure lives in a ref so the effect
  // only depends on the path and the debounce
  const reload = useRef<(path: string) => void>(() => {});
  reload.current = (path: string) => {
    if (!path.trim()) return update({ workflows: [], workflow: '', orgError: 'org is required' });
    try {
      const loaded = loadOrg(resolve(path));
      const names = Object.keys(loaded.workflows);
      update({
        workflows: names,
        workflow: names.includes(f.workflow) ? f.workflow : (names[0] ?? ''),
        adapter: !f.adapterTouched && loaded.org.adapter ? loaded.org.adapter : f.adapter,
        orgError: undefined,
      });
    } catch (e) {
      update({
        workflows: [],
        workflow: '',
        orgError: e instanceof Error ? e.message : String(e),
      });
    }
  };
  useEffect(() => {
    const t = setTimeout(() => reload.current(orgPath), debounceMs);
    return () => clearTimeout(t);
  }, [orgPath, debounceMs]);

  const submit = async () => {
    if (f.busy) return;
    if (f.orgError) return update({ error: f.orgError });
    if (!f.workflow) return update({ error: 'Pick a workflow' });
    if (!f.input.trim()) return update({ error: 'Input is required' });
    const budgetUsd = f.budget.trim() ? Number(f.budget) : undefined;
    if (budgetUsd !== undefined && !(budgetUsd > 0))
      return update({ error: 'Budget must be a positive number' });
    update({ error: undefined, busy: true });
    try {
      const runId = await onSubmit({
        orgRoot: resolve(f.org),
        project: resolve(f.project),
        workflow: f.workflow,
        input: f.input.trim(),
        adapter: f.adapter as SubmitRequest['adapter'],
        workspace: f.workspace === 'auto' ? undefined : (f.workspace as SubmitRequest['workspace']),
        budgetUsd,
      });
      if (!runId) return update({ error: 'Could not submit the run', busy: false });
      savePrefs(home, {
        lastOrg: resolve(f.org),
        lastProject: resolve(f.project),
        lastAdapter: f.adapter,
        lastWorkspace: f.workspace,
      });
      update({ busy: false });
      onDone(runId);
    } catch (e) {
      update({ error: e instanceof Error ? e.message : String(e), busy: false });
    }
  };

  const editText = (field: TextField, fn: (v: string) => string) => {
    // any edit clears the last submit error
    update({ [field]: fn(f[field]), error: undefined });
    if (field === 'org') setOrgPath(f.org);
  };
  const choose = (field: Field, delta: 1 | -1) => {
    if (field === 'workflow' && f.workflows.length)
      update({ workflow: cycle(f.workflows, f.workflow, delta) });
    else if (field === 'adapter')
      update({
        adapter: cycle(ADAPTERS, f.adapter as (typeof ADAPTERS)[number], delta),
        adapterTouched: true,
      });
    else if (field === 'workspace')
      update({ workspace: cycle(WORKSPACES, f.workspace as (typeof WORKSPACES)[number], delta) });
  };

  useInput((ch, key) => {
    if (key.escape) return onCancel();
    if (key.tab) return update({ field: cycle(FIELDS, f.field, key.shift ? -1 : 1) });
    if (key.return) return void submit();
    const field = f.field;
    if (CHOICE_FIELDS.includes(field)) {
      if (ch === 'j' || key.downArrow || key.rightArrow) return choose(field, 1);
      if (ch === 'k' || key.upArrow || key.leftArrow) return choose(field, -1);
      return;
    }
    const text = field as TextField;
    if (key.backspace || key.delete || ch === '\u007f' || ch === '\b')
      return editText(text, (v) => v.slice(0, -1));
    if (ch && !key.ctrl && !key.meta) editText(text, (v) => v + ch);
  });

  const row = (field: Field, label: string, value: string, hint?: string) => {
    const focused = f.field === field;
    const choice = CHOICE_FIELDS.includes(field);
    return (
      <Box key={field} flexDirection="column">
        <Box>
          <Text color={focused ? colors.focus : colors.muted}>{focused ? '▸ ' : '  '}</Text>
          <Text color={colors.muted}>{label.padEnd(10)}</Text>
          <Text bold={focused}>
            {choice ? `◂ ${value || '—'} ▸` : value}
            {focused && !choice ? <Text color={colors.focus}>▏</Text> : ''}
          </Text>
        </Box>
        {hint ? (
          <Text color={colors.danger}>
            {'            '}
            {hint}
          </Text>
        ) : null}
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      <Text bold color={colors.focus}>
        New run
      </Text>
      {row('org', 'org', f.org, f.orgError)}
      {row('project', 'project', f.project)}
      {row('workflow', 'workflow', f.workflow || (f.workflows.length ? '' : '(no workflows)'))}
      {row('input', 'input', f.input)}
      {row('adapter', 'adapter', f.adapter)}
      {row('workspace', 'workspace', f.workspace)}
      {row('budget', 'budget', f.budget)}
      {f.error ? (
        <Text color={colors.danger}>{f.error}</Text>
      ) : (
        <Text color={colors.muted}>
          {f.busy ? 'Submitting…' : 'tab next · j/k change · enter submit · esc cancel'}
        </Text>
      )}
    </Box>
  );
}
