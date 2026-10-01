import type { RoutineApprovals, RoutineTrigger } from '@wizardingcode/shibaox-schemas';
import { triggerWords } from '@wizardingcode/shibaox-view';
import { useEffect, useMemo, useState } from 'react';
import { ds } from '../../ds.js';
import { shortModel } from '../../format.js';
import { useAppState, useStore } from '../../store/hooks.js';
import { DAYS, FREQUENCIES, type Frequency, fromTrigger, toTrigger } from './frequency.js';

/** What the dialog edits and hands back. */
export interface RoutineForm {
  name: string;
  description: string;
  input: string;
  trigger: RoutineTrigger;
  workflow: string;
  project?: string;
  model?: string;
  approvals: RoutineApprovals;
  adapter?: string;
  budgetUsd?: number;
  maxDailyUsd?: number;
  mode?: 'always' | 'on_change';
  intervalS?: number;
}

export const EMPTY_FORM: RoutineForm = {
  name: '',
  description: '',
  input: '',
  trigger: { type: 'cron', cron: '0 9 * * 1-5' },
  workflow: 'chat',
  approvals: 'inbox',
};

const APPROVALS: { id: RoutineApprovals; label: string; hint: string; note: string }[] = [
  {
    id: 'inbox',
    label: 'Manually approve',
    hint: 'Shibaox pauses and asks in the inbox',
    note: 'Pushes, deploys, commands, network and protected files wait for you in the inbox, as in any run.',
  },
  {
    id: 'auto',
    label: 'Automatically approve',
    hint: 'runs push, deploy, commands and network without asking',
    note: 'For this routine, Shibaox pushes, deploys, runs commands and reaches the network without asking. Human steps of the workflow still wait.',
  },
  {
    id: 'skip',
    label: 'Skip all approvals',
    hint: 'never pauses, human steps included',
    note: 'This routine never pauses, not even at the human steps of its workflow. Only for work you would let run while you sleep.',
  },
];

const num = (v: string): number | undefined => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The frequency fields: a time, a day, a cron, or what a watcher looks at. */
function FrequencyFields(props: {
  value: Frequency;
  onChange: (f: Frequency) => void;
}): JSX.Element | null {
  const S = ds();
  const f = props.value;
  const time = (t: string) => props.onChange({ ...f, time: t } as Frequency);
  switch (f.kind) {
    case 'daily':
    case 'weekdays':
      return (
        <S.Input
          label="Time"
          type="time"
          value={f.time}
          onChange={(e) => time((e.target as HTMLInputElement).value)}
        />
      );
    case 'weekly':
      return (
        <div className="row">
          <S.Select
            label="Day"
            value={String(f.day)}
            options={DAYS.map((d, i) => ({ id: String(i), label: d }))}
            onChange={(id) => props.onChange({ ...f, day: Number(id) })}
          />
          <S.Input
            label="Time"
            type="time"
            value={f.time}
            onChange={(e) => time((e.target as HTMLInputElement).value)}
          />
        </div>
      );
    case 'monthly':
      return (
        <div className="row">
          <S.Input
            label="Day of the month"
            type="number"
            min={1}
            max={28}
            value={String(f.dayOfMonth)}
            onChange={(e) =>
              props.onChange({
                ...f,
                dayOfMonth: Math.min(
                  28,
                  Math.max(1, Number((e.target as HTMLInputElement).value) || 1),
                ),
              })
            }
          />
          <S.Input
            label="Time"
            type="time"
            value={f.time}
            onChange={(e) => time((e.target as HTMLInputElement).value)}
          />
        </div>
      );
    case 'cron':
      return (
        <S.Input
          label="Cron expression"
          placeholder="0 9 * * 1-5"
          hint="minute hour day-of-month month day-of-week, on the daemon machine's clock"
          value={f.cron}
          onChange={(e) => props.onChange({ ...f, cron: (e.target as HTMLInputElement).value })}
        />
      );
    case 'github':
      return (
        <>
          <S.Select
            label="What to watch"
            value={f.watch}
            options={[
              { id: 'issues', label: 'Issues', hint: 'new open issues' },
              { id: 'prs', label: 'Pull requests', hint: 'new open pull requests' },
              { id: 'checks', label: 'Checks (CI)', hint: 'a red workflow run' },
            ]}
            onChange={(id) => props.onChange({ ...f, watch: id as 'issues' | 'prs' | 'checks' })}
          />
          <S.Input
            label="Repository"
            placeholder="owner/name (empty: the project's origin)"
            value={f.repo ?? ''}
            onChange={(e) => props.onChange({ ...f, repo: (e.target as HTMLInputElement).value })}
          />
          {f.watch === 'checks' ? (
            <S.Input
              label="Branch"
              placeholder="empty: the default branch"
              value={f.branch ?? ''}
              onChange={(e) =>
                props.onChange({ ...f, branch: (e.target as HTMLInputElement).value })
              }
            />
          ) : (
            <S.Input
              label="Label"
              placeholder="only with this label (optional)"
              value={f.label ?? ''}
              onChange={(e) =>
                props.onChange({ ...f, label: (e.target as HTMLInputElement).value })
              }
            />
          )}
        </>
      );
    case 'url':
      return (
        <S.Input
          label="URL"
          placeholder="https://…"
          value={f.url}
          onChange={(e) => props.onChange({ ...f, url: (e.target as HTMLInputElement).value })}
        />
      );
    case 'file':
      return (
        <S.Input
          label="Path"
          placeholder="a path on the daemon machine"
          value={f.path}
          onChange={(e) => props.onChange({ ...f, path: (e.target as HTMLInputElement).value })}
        />
      );
    case 'command':
      return (
        <S.Input
          label="Command"
          placeholder="git status --porcelain"
          value={f.command}
          onChange={(e) => props.onChange({ ...f, command: (e.target as HTMLInputElement).value })}
        />
      );
    default:
      return null;
  }
}

const defaultFor = (kind: Frequency['kind']): Frequency => {
  switch (kind) {
    case 'daily':
    case 'weekdays':
      return { kind, time: '09:00' };
    case 'weekly':
      return { kind, time: '09:00', day: 1 };
    case 'monthly':
      return { kind, time: '09:00', dayOfMonth: 1 };
    case 'cron':
      return { kind, cron: '0 9 * * 1-5' };
    case 'github':
      return { kind, watch: 'issues' };
    case 'url':
      return { kind, url: '' };
    case 'file':
      return { kind, path: '' };
    case 'command':
      return { kind, command: '' };
    default:
      return { kind } as Frequency;
  }
};

/**
 * Create or edit a routine: name, instructions, project and model, a frequency preset,
 * permissions with a plain warning, and the advanced settings folded away.
 */
export function RoutineDialog(props: {
  title: 'Create routine' | 'Edit routine';
  initial: RoutineForm;
  /** An org routine being edited: say it detaches from its file. */
  fromOrg?: boolean;
  onSave: (form: RoutineForm) => Promise<boolean>;
  onClose: () => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const [form, setForm] = useState<RoutineForm>(props.initial);
  const [freq, setFreq] = useState<Frequency>(() => fromTrigger(props.initial.trigger));
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!state.skills) void store.loadSkills();
    if (!state.projects) void store.loadProjects();
    if (!state.integrations) void store.loadIntegrations();
  }, [store, state.skills, state.projects, state.integrations]);
  const trigger = useMemo(() => toTrigger(freq), [freq]);
  const words = triggerWords(trigger);
  const workflows = state.skills?.workflows.map((w) => w.name) ?? [];
  const workflowOptions = (workflows.length ? workflows : ['chat']).map((w) => ({
    id: w,
    label: w,
    hint: state.skills?.workflows.find((x) => x.name === w)?.description || undefined,
  }));
  if (form.workflow && !workflowOptions.some((o) => o.id === form.workflow))
    workflowOptions.push({ id: form.workflow, label: form.workflow, hint: undefined });
  const projects = state.projects?.map((p) => p.path) ?? [];
  const projectOptions = [...new Set([...(form.project ? [form.project] : []), ...projects])].map(
    (p) => ({
      id: p,
      label: p.split('/').pop() || p,
      hint: p,
    }),
  );
  const models = (state.integrations?.models ?? []).filter((m) => m.configured || m.available);
  const modelOptions = [
    { id: '', label: "The org's tiers", hint: 'strong for tasks, cheap for summaries' },
    ...models.map((m) => ({ id: m.ref, label: shortModel(m.ref) ?? m.ref, hint: m.provider })),
  ];
  const approval = APPROVALS.find((a) => a.id === form.approvals) ?? APPROVALS[0];
  const watching =
    freq.kind === 'cron'
      ? freq.cron.trim() !== ''
      : freq.kind === 'url'
        ? freq.url.trim() !== ''
        : freq.kind === 'file'
          ? freq.path.trim() !== ''
          : freq.kind === 'command'
            ? freq.command.trim() !== ''
            : true;
  const valid = form.name.trim() !== '' && form.input.trim() !== '' && watching;
  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(undefined);
    const ok = await props.onSave({
      ...form,
      trigger,
      name: form.name.trim(),
      input: form.input.trim(),
      description: form.description.trim(),
    });
    setSaving(false);
    if (ok) props.onClose();
    else setError('The daemon refused it: see the message at the bottom right.');
  };
  return (
    <S.Dialog
      open
      title={props.title}
      description={
        props.fromOrg
          ? 'This routine comes from the org files; saving here detaches it from them.'
          : 'What Shibaox does on its own, and when.'
      }
      icon="clock"
      onClose={props.onClose}
      footer={
        <>
          <S.Button variant="quiet" onClick={props.onClose}>
            Cancel
          </S.Button>
          <S.Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!valid}
            loading={saving}
          >
            Save
          </S.Button>
        </>
      }
    >
      <S.Input
        label="Name"
        placeholder="Daily briefing"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })}
      />
      <S.Textarea
        label="Instructions"
        placeholder="Check tomorrow's weather and tell me if I need an umbrella."
        rows={4}
        value={form.input}
        onChange={(e) => setForm({ ...form, input: (e.target as HTMLTextAreaElement).value })}
      />
      <div className="row">
        <S.Select
          label="Project"
          value={form.project ?? ''}
          placeholder="The default project"
          options={projectOptions}
          onChange={(id) => setForm({ ...form, project: id || undefined })}
        />
        <S.Select
          label="Model"
          value={form.model ?? ''}
          options={modelOptions}
          onChange={(id) => setForm({ ...form, model: id || undefined })}
        />
      </div>
      <S.Select
        label="Frequency"
        value={freq.kind}
        options={FREQUENCIES.map((f) => ({ id: f.id, label: f.label, hint: f.hint }))}
        onChange={(id) => {
          setFreq(defaultFor(id as Frequency['kind']));
          // the daemon picks the guards of the new kind (on_change, the daily cap)
          setForm({ ...form, mode: undefined, intervalS: undefined });
        }}
      />
      <FrequencyFields value={freq} onChange={setFreq} />
      <p className="muted">
        {words}
        {trigger.type === 'cron' ? ` · the daemon machine's clock` : ''}
      </p>
      <S.Select
        label="Permissions"
        value={form.approvals}
        options={APPROVALS.map((a) => ({ id: a.id, label: a.label, hint: a.hint }))}
        onChange={(id) => setForm({ ...form, approvals: id as RoutineApprovals })}
      />
      <p className={form.approvals === 'inbox' ? 'muted' : 'note'}>{approval?.note}</p>
      <S.Button
        variant="quiet"
        size="sm"
        iconRight={advanced ? 'chevron-down' : 'chevron-right'}
        aria-expanded={advanced}
        onClick={() => setAdvanced((a) => !a)}
      >
        Advanced settings
      </S.Button>
      {advanced ? (
        <div className="stack">
          <S.Select
            label="Workflow"
            value={form.workflow}
            options={workflowOptions}
            onChange={(id) => setForm({ ...form, workflow: id })}
          />
          <S.Select
            label="Adapter"
            value={form.adapter ?? ''}
            options={[
              { id: '', label: "The org's adapter" },
              { id: 'direct', label: 'direct', hint: 'API keys from the vault' },
              { id: 'claude-code', label: 'claude-code', hint: 'the Claude subscription' },
              { id: 'mock', label: 'mock', hint: 'no model: a dry run' },
            ]}
            onChange={(id) => setForm({ ...form, adapter: id || undefined })}
          />
          <div className="row">
            <S.Input
              label="Budget per run (USD)"
              type="number"
              min={0}
              step={0.5}
              placeholder="the org's"
              value={form.budgetUsd ?? ''}
              onChange={(e) =>
                setForm({ ...form, budgetUsd: num((e.target as HTMLInputElement).value) })
              }
            />
            <S.Input
              label="Daily cap (USD)"
              type="number"
              min={0}
              step={1}
              placeholder="10 for watchers"
              value={form.maxDailyUsd ?? ''}
              onChange={(e) =>
                setForm({ ...form, maxDailyUsd: num((e.target as HTMLInputElement).value) })
              }
            />
          </div>
          {trigger.type !== 'cron' && trigger.type !== 'manual' ? (
            <div className="row">
              <S.Select
                label="Fire"
                value={form.mode ?? 'on_change'}
                options={[
                  { id: 'on_change', label: 'When what it sees changes' },
                  { id: 'always', label: 'Every look, changed or not' },
                ]}
                onChange={(id) => setForm({ ...form, mode: id as 'always' | 'on_change' })}
              />
              <S.Input
                label="Check interval (seconds)"
                type="number"
                min={30}
                placeholder="120"
                value={form.intervalS ?? ''}
                onChange={(e) =>
                  setForm({ ...form, intervalS: num((e.target as HTMLInputElement).value) })
                }
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="note">{state.error ? `The daemon refused it: ${state.error}` : error}</p>
      ) : null}
    </S.Dialog>
  );
}
