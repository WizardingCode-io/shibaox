import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { useKeyboard } from '@opentui/react';
import type { SubmitRequest } from '@shibaox/daemon';
import { loadOrg as loadOrgDefault } from '@shibaox/schemas';
import { useEffect, useRef, useState } from 'react';
import { loadPrefs, savePrefs } from '../prefs.js';
import { colors } from '../theme.js';
import { Line, Panel } from './widgets.js';

export interface NewRunFormProps {
  cwd: string;
  home: string;
  onSubmit: (req: SubmitRequest) => Promise<string | undefined>;
  onCancel: () => void;
  onDone: (runId: string) => void;
  debounceMs?: number;
  loadOrg?: typeof loadOrgDefault;
}

const FIELDS = ['org', 'project', 'workflow', 'input', 'adapter', 'workspace', 'budget'] as const;
type Field = (typeof FIELDS)[number];
const ADAPTERS = ['mock', 'direct', 'claude-code'];
const WORKSPACES = ['auto', 'inplace', 'worktree'];
const expandHome = (p: string) =>
  p.startsWith('~/') ? join(process.env.HOME ?? '', p.slice(2)) : p;

/** The form behind `N`: text fields are `<input>`s, choices are `<select>`s; tab moves the focus. */
export function NewRunForm(props: NewRunFormProps) {
  const { cwd, home, onSubmit, onCancel, onDone } = props;
  const loadOrg = props.loadOrg ?? loadOrgDefault;
  const prefs = useRef(loadPrefs(home)).current;
  const [org, setOrg] = useState(
    existsSync(join(cwd, 'org')) ? join(cwd, 'org') : (prefs.lastOrg ?? ''),
  );
  const [project, setProject] = useState(cwd);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [workflow, setWorkflow] = useState('');
  const [input, setInput] = useState('');
  const [adapter, setAdapter] = useState(prefs.lastAdapter ?? 'mock');
  const [workspace, setWorkspace] = useState(prefs.lastWorkspace ?? 'auto');
  const [budget, setBudget] = useState('');
  const [field, setField] = useState<Field>('org');
  const [orgError, setOrgError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const adapterTouched = useRef(prefs.lastAdapter !== undefined);

  // reload the org when its path settles
  const latest = useRef({ workflow, adapter });
  latest.current = { workflow, adapter };
  useEffect(() => {
    const t = setTimeout(() => {
      if (!org.trim()) {
        setWorkflows([]);
        setOrgError('org is required');
        return;
      }
      try {
        const loaded = loadOrg(resolve(expandHome(org)));
        const names = Object.keys(loaded.workflows);
        setWorkflows(names);
        setWorkflow(
          names.includes(latest.current.workflow) ? latest.current.workflow : (names[0] ?? ''),
        );
        if (!adapterTouched.current && loaded.org.adapter) setAdapter(loaded.org.adapter);
        setOrgError(undefined);
      } catch (e) {
        setWorkflows([]);
        setWorkflow('');
        setOrgError(e instanceof Error ? e.message : String(e));
      }
    }, props.debounceMs ?? 300);
    return () => clearTimeout(t);
  }, [org, props.debounceMs, loadOrg]);

  const submit = async () => {
    if (busy) return;
    if (orgError) return setError(orgError);
    if (!workflow) return setError('Pick a workflow');
    if (!input.trim()) return setError('Input is required');
    const budgetUsd = budget.trim() ? Number(budget) : undefined;
    if (budgetUsd !== undefined && !(budgetUsd > 0))
      return setError('Budget must be a positive number');
    setError(undefined);
    setBusy(true);
    try {
      const runId = await onSubmit({
        orgRoot: resolve(expandHome(org)),
        project: resolve(expandHome(project)),
        workflow,
        input: input.trim(),
        adapter: adapter as SubmitRequest['adapter'],
        workspace: workspace === 'auto' ? undefined : (workspace as SubmitRequest['workspace']),
        budgetUsd,
      });
      if (!runId) return setError('Could not submit the run');
      try {
        savePrefs(home, {
          lastOrg: resolve(expandHome(org)),
          lastAdapter: adapter,
          lastWorkspace: workspace,
        });
      } catch {
        // preferences are a convenience: never fail a submitted run over them
      }
      onDone(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useKeyboard((key) => {
    if (key.name === 'escape') return onCancel();
    if (key.name === 'tab') {
      const i = FIELDS.indexOf(field);
      return setField(FIELDS[(i + (key.shift ? -1 : 1) + FIELDS.length) % FIELDS.length] as Field);
    }
    if (key.name === 'return' && !['workflow', 'adapter', 'workspace'].includes(field))
      void submit();
  });

  const label = (f: Field, text: string) => (
    <text
      fg={field === f ? colors.focus : colors.muted}
    >{`${field === f ? '▸ ' : '  '}${text.padEnd(10)}`}</text>
  );
  const textField = (f: Field, value: string, set: (v: string) => void, hint?: string) => (
    <box flexDirection="column" flexShrink={0}>
      <Line>
        {label(f, f)}
        <input focused={field === f} value={value} onInput={set} width={60} />
      </Line>
      {hint ? (
        <Line>
          <text fg={colors.danger}>{`            ${hint}`}</text>
        </Line>
      ) : null}
    </box>
  );
  const choice = (f: Field, options: string[], value: string, set: (v: string) => void) => (
    <box flexDirection="row" flexShrink={0}>
      {label(f, f)}
      {field === f ? (
        <select
          focused
          options={options.map((o) => ({ name: o, value: o, description: '' }))}
          selectedIndex={Math.max(0, options.indexOf(value))}
          onChange={(_i, o) => set(String(o?.value ?? value))}
          height={Math.max(1, options.length)}
          width={40}
        />
      ) : (
        <text>{value || '—'}</text>
      )}
    </box>
  );

  return (
    <Panel title="New run" focused flexGrow={1}>
      {textField('org', org, setOrg, orgError)}
      {textField('project', project, setProject)}
      {choice('workflow', workflows.length ? workflows : ['(no workflows)'], workflow, setWorkflow)}
      {textField('input', input, setInput)}
      {choice('adapter', ADAPTERS, adapter, setAdapter)}
      {choice('workspace', WORKSPACES, workspace, setWorkspace)}
      {textField('budget', budget, setBudget)}
      <Line>
        {error ? (
          <text fg={colors.danger}>{error}</text>
        ) : (
          <text fg={colors.muted}>
            {busy ? 'Submitting…' : 'tab next field · ↑/↓ pick · enter submit · esc cancel'}
          </text>
        )}
      </Line>
    </Panel>
  );
}
