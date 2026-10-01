import type { RoutineRow } from '@wizardingcode/shibaox-daemon';
import { useEffect, useState } from 'react';
import { ds } from '../ds.js';
import { when } from '../format.js';
import { navigate } from '../router.js';
import { useAppState, useStore } from '../store/hooks.js';

/** A trigger in words. */
export function triggerWords(t: RoutineRow['trigger']): string {
  switch (t.type) {
    case 'cron':
      return `cron ${t.cron}`;
    case 'github':
      return `GitHub ${t.watch}${t.label ? ` labelled ${t.label}` : ''}${t.repo ? ` on ${t.repo}` : ''}${t.branch ? ` (${t.branch})` : ''}`;
    case 'url':
      return `when ${t.url} changes`;
    case 'file':
      return `when ${t.path} changes`;
    case 'command':
      return `when \`${t.command}\` changes`;
    case 'manual':
      return 'by hand';
  }
}

type TriggerType = RoutineRow['trigger']['type'];
const TRIGGERS: { id: TriggerType; label: string; hint: string }[] = [
  { id: 'cron', label: 'On a schedule (cron)', hint: '0 9 * * 1' },
  { id: 'github', label: 'GitHub issues, PRs or checks', hint: 'issues | prs | checks' },
  { id: 'url', label: 'When a page changes', hint: 'https://…' },
  { id: 'file', label: 'When a file changes', hint: 'a path on the daemon machine' },
  { id: 'command', label: "When a command's output changes", hint: 'git status --porcelain' },
];

function AddRoutine(props: { onDone: () => void }): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const [type, setType] = useState<TriggerType>('cron');
  const [value, setValue] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [input, setInput] = useState('');
  const [name, setName] = useState('');
  const [watch, setWatch] = useState<'issues' | 'prs' | 'checks'>('issues');
  const [repo, setRepo] = useState('');
  const [label, setLabel] = useState('');
  const [branch, setBranch] = useState('');
  useEffect(() => {
    if (!state.skills) void store.loadSkills();
  }, [store, state.skills]);
  const trigger = (): RoutineRow['trigger'] => {
    const v = value.trim();
    if (type === 'cron') return { type, cron: v };
    if (type === 'github')
      return {
        type,
        watch,
        ...(repo.trim() ? { repo: repo.trim() } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(branch.trim() ? { branch: branch.trim() } : {}),
      };
    if (type === 'url') return { type, url: v };
    if (type === 'file') return { type, path: v };
    return { type: 'command', command: v };
  };
  const hint = TRIGGERS.find((t) => t.id === type)?.hint;
  return (
    <S.Card
      title="New routine"
      description="What the daemon watches, and the workflow it runs when the trigger fires."
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if ((type !== 'github' && !value.trim()) || !workflow.trim()) return;
          void store
            .addRoutine({
              trigger: trigger(),
              workflow: workflow.trim(),
              input: input.trim(),
              ...(name.trim() ? { name: name.trim() } : {}),
            })
            .then((ok) => {
              if (ok) props.onDone();
            });
        }}
      >
        <label className="muted" htmlFor="routine-trigger">
          Trigger
        </label>
        <select
          id="routine-trigger"
          className="sx-select"
          value={type}
          onChange={(e) => setType(e.target.value as TriggerType)}
        >
          {TRIGGERS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {type === 'github' ? (
          <>
            <label className="muted" htmlFor="routine-watch">
              What to watch
            </label>
            <select
              id="routine-watch"
              className="sx-select"
              value={watch}
              onChange={(e) => setWatch(e.target.value as typeof watch)}
            >
              <option value="issues">Issues</option>
              <option value="prs">Pull requests</option>
              <option value="checks">Checks (CI)</option>
            </select>
            <S.Input
              label="Repository"
              placeholder="owner/name (empty = the project's origin)"
              value={repo}
              onChange={(e) => setRepo((e.target as HTMLInputElement).value)}
            />
            {watch === 'checks' ? (
              <S.Input
                label="Branch"
                placeholder="empty = the default branch"
                value={branch}
                onChange={(e) => setBranch((e.target as HTMLInputElement).value)}
              />
            ) : (
              <S.Input
                label="Label"
                placeholder="only issues or PRs with this label (optional)"
                value={label}
                onChange={(e) => setLabel((e.target as HTMLInputElement).value)}
              />
            )}
          </>
        ) : (
          <S.Input
            label="Watch"
            placeholder={hint}
            value={value}
            onChange={(e) => setValue((e.target as HTMLInputElement).value)}
          />
        )}
        <S.Input
          label="Workflow"
          placeholder={state.skills?.workflows.map((w) => w.name).join(', ') || 'hello-feature'}
          value={workflow}
          onChange={(e) => setWorkflow((e.target as HTMLInputElement).value)}
        />
        <S.Input
          label="Request"
          placeholder="What the run is asked to do"
          value={input}
          onChange={(e) => setInput((e.target as HTMLInputElement).value)}
        />
        <S.Input
          label="Name"
          placeholder="Optional"
          value={name}
          onChange={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <div className="row">
          <S.Button variant="primary" type="submit">
            Save routine
          </S.Button>
          <S.Button variant="quiet" type="button" onClick={props.onDone}>
            Cancel
          </S.Button>
        </div>
      </form>
    </S.Card>
  );
}

/** The daemon's routines: what it does on its own, and when. */
export function ScheduledScreen(): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    void store.loadRoutines();
  }, [store]);
  const routines = state.routines ?? [];
  return (
    <main className="main">
      <div className="top">
        <h2>Scheduled</h2>
        <span className="grow" />
        <S.Button size="sm" onClick={() => void store.syncRoutines()}>
          Sync from org
        </S.Button>
        <S.Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>
          Add routine
        </S.Button>
      </div>
      <div className="page sx-scroll">
        {adding ? <AddRoutine onDone={() => setAdding(false)} /> : null}
        {routines.length === 0 && !adding ? (
          <div className="empty">
            <h2>Nothing scheduled</h2>
            <p>A routine runs a workflow on a schedule, or when something it watches changes.</p>
          </div>
        ) : null}
        {routines.map((r) => (
          <S.Card
            key={r.id}
            icon="clock"
            title={r.name ?? r.id}
            description={`${triggerWords(r.trigger)} · ${r.workflow} · ${r.project}`}
            action={
              <S.Badge tone={r.enabled ? 'matcha' : 'neutral'}>
                {r.enabled ? 'On' : 'Paused'}
              </S.Badge>
            }
            footer={
              <div className="row">
                <span className="muted">
                  {r.source === 'org' ? 'from the org' : 'added here'}
                  {r.lastFiredAt ? ` · last run ${when(r.lastFiredAt)}` : ' · never ran'}
                </span>
                <span className="grow" />
                {r.lastRunId ? (
                  <S.Button
                    size="sm"
                    variant="quiet"
                    onClick={() => navigate(`#/t/${encodeURIComponent(r.lastRunId as string)}`)}
                  >
                    Open last run
                  </S.Button>
                ) : null}
                <S.Button size="sm" icon="play" onClick={() => void store.runRoutine(r.id)}>
                  Run now
                </S.Button>
                {r.enabled ? (
                  <S.Button size="sm" onClick={() => void store.pauseRoutine(r.id)}>
                    Pause
                  </S.Button>
                ) : (
                  <S.Button size="sm" onClick={() => void store.resumeRoutine(r.id)}>
                    Resume
                  </S.Button>
                )}
                {r.source === 'api' ? (
                  <S.Button
                    size="sm"
                    variant="danger"
                    onClick={() => void store.removeRoutine(r.id)}
                  >
                    Remove
                  </S.Button>
                ) : null}
              </div>
            }
          />
        ))}
      </div>
    </main>
  );
}
