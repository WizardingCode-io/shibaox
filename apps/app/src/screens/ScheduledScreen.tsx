import type { RoutineView } from '@wizardingcode/shibaox-daemon';
import type { RoutineApprovals } from '@wizardingcode/shibaox-schemas';
import { triggerWords } from '@wizardingcode/shibaox-view';
import { useEffect, useMemo, useState } from 'react';
import { ds } from '../ds.js';
import { money, RUN_STATUS_WORD, relative, when } from '../format.js';
import { navigate } from '../router.js';
import { useAppState, useStore } from '../store/hooks.js';
import { EMPTY_FORM, RoutineDialog, type RoutineForm } from './scheduled/RoutineDialog.js';
import { TEMPLATES } from './scheduled/templates.js';

export { triggerWords };

type Sort = 'next' | 'name' | 'last';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'next', label: 'Next run' },
  { id: 'name', label: 'Name' },
  { id: 'last', label: 'Last run' },
];

const formOf = (r: RoutineView): RoutineForm => ({
  name: r.name ?? r.id,
  description: r.description ?? '',
  input: r.input,
  trigger: r.trigger,
  workflow: r.workflow,
  project: r.project,
  model: r.model,
  approvals: r.approvals ?? 'inbox',
  adapter: r.adapter,
  budgetUsd: r.budgetUsd,
  maxDailyUsd: r.maxDailyUsd,
  mode: r.mode,
  intervalS: r.intervalS,
});

const sortBy = (rows: RoutineView[], sort: Sort): RoutineView[] =>
  [...rows].sort((a, b) => {
    if (sort === 'name') return (a.name ?? a.id).localeCompare(b.name ?? b.id);
    if (sort === 'last')
      return (b.lastRun?.createdAt ?? '').localeCompare(a.lastRun?.createdAt ?? '');
    // next run: soonest first, those that never run on their own last
    if (!a.nextRunAt && !b.nextRunAt) return (a.name ?? a.id).localeCompare(b.name ?? b.id);
    if (!a.nextRunAt) return 1;
    if (!b.nextRunAt) return -1;
    return a.nextRunAt.localeCompare(b.nextRunAt);
  });

/** One routine: what it does, when, how its last run went, and its actions. */
function RoutineCard(props: {
  r: RoutineView;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const r = props.r;
  const [menu, setMenu] = useState(false);
  const name = r.name ?? r.id;
  const last = r.lastRun;
  return (
    <S.Card
      title={name}
      description={r.description || r.input.split('\n')[0] || r.workflow}
      action={
        <S.Menu
          open={menu}
          onClose={() => setMenu(false)}
          align="end"
          anchor={
            <S.IconButton
              icon="chevron-down"
              label={`Actions for ${name}`}
              size="sm"
              onClick={() => setMenu((m) => !m)}
            />
          }
          items={[
            { id: 'run', label: 'Run now', icon: 'play' },
            r.enabled
              ? { id: 'pause', label: 'Pause', icon: 'square' }
              : { id: 'resume', label: 'Resume', icon: 'play' },
            { id: 'edit', label: 'Edit', icon: 'wrench' },
            { id: 'duplicate', label: 'Duplicate', icon: 'copy' },
            ...(last ? [{ id: 'open', label: 'Open last run', icon: 'history' as const }] : []),
            { id: '-', label: '' },
            { id: 'remove', label: 'Remove', icon: 'x', tone: 'danger' as const },
          ]}
          onSelect={(id) => {
            if (id === 'run') void store.runRoutine(r.id);
            else if (id === 'pause') void store.pauseRoutine(r.id);
            else if (id === 'resume') void store.resumeRoutine(r.id);
            else if (id === 'edit') props.onEdit();
            else if (id === 'duplicate') props.onDuplicate();
            else if (id === 'open' && last) navigate(`#/t/${encodeURIComponent(last.runId)}`);
            else if (id === 'remove') props.onRemove();
          }}
        />
      }
      footer={
        <div className="stack" style={{ flex: 1 }}>
          <div className="row">
            <S.Badge icon="clock">{r.words || triggerWords(r.trigger)}</S.Badge>
            {!r.enabled ? <S.Badge>Paused</S.Badge> : null}
            {r.source === 'org' ? <S.Badge>from the org</S.Badge> : null}
            {r.approvals === 'auto' ? (
              <S.Badge tone="warning" icon="triangle-alert">
                Auto approvals
              </S.Badge>
            ) : r.approvals === 'skip' ? (
              <S.Badge tone="danger" icon="triangle-alert">
                Skips approvals
              </S.Badge>
            ) : null}
            {r.model ? <S.Badge icon="brain">{r.model.split('/').pop()}</S.Badge> : null}
          </div>
          <div className="row">
            <span className="muted">
              {r.nextRunAt
                ? `Next run ${relative(r.nextRunAt)} · ${when(r.nextRunAt)}`
                : r.enabled
                  ? 'Runs when you press Run now'
                  : 'Not running while paused'}
            </span>
            <span className="grow" />
            {last ? (
              <S.Button
                size="sm"
                variant="quiet"
                onClick={() => navigate(`#/t/${encodeURIComponent(last.runId)}`)}
              >
                {`Last run: ${RUN_STATUS_WORD[last.status] ?? last.status} · ${money(last.spentUsd)} · ${relative(last.createdAt)}`}
              </S.Button>
            ) : (
              <span className="muted">never ran</span>
            )}
          </div>
        </div>
      }
    />
  );
}

/** The daemon's routines: what it does on its own, and when. */
export function ScheduledScreen(): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('next');
  const [sortOpen, setSortOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: 'create'; form: RoutineForm }
    | { kind: 'edit'; id: string; form: RoutineForm; fromOrg: boolean }
    | { kind: 'ask' }
    | { kind: 'remove'; r: RoutineView }
    | undefined
  >(undefined);
  const [sentence, setSentence] = useState('');
  const [drafting, setDrafting] = useState(false);
  useEffect(() => {
    void store.loadRoutines();
  }, [store]);
  const routines = state.routines ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (r: RoutineView) =>
      !q ||
      [r.name ?? '', r.id, r.description ?? '', r.input, r.workflow, r.words ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q);
    return sortBy(routines.filter(hit), sort);
  }, [routines, query, sort]);
  const save =
    (id?: string) =>
    async (f: RoutineForm): Promise<boolean> => {
      const body = {
        name: f.name,
        description: f.description || undefined,
        input: f.input,
        trigger: f.trigger,
        workflow: f.workflow,
        ...(f.project ? { project: f.project } : {}),
        model: f.model,
        approvals: f.approvals as RoutineApprovals,
        adapter: f.adapter,
        budgetUsd: f.budgetUsd,
        maxDailyUsd: f.maxDailyUsd,
        mode: f.mode,
        intervalS: f.intervalS,
      };
      return id ? store.updateRoutine(id, body) : store.addRoutine(body);
    };
  return (
    <main className="main">
      <div className="top">
        <h2>Scheduled</h2>
        <span className="grow" />
        <S.Button size="sm" variant="quiet" onClick={() => void store.syncRoutines()}>
          Sync from org
        </S.Button>
        <S.Menu
          open={newOpen}
          onClose={() => setNewOpen(false)}
          align="end"
          anchor={
            <S.Button
              size="sm"
              variant="primary"
              icon="plus"
              iconRight="chevron-down"
              onClick={() => setNewOpen((o) => !o)}
            >
              New routine
            </S.Button>
          }
          items={[
            {
              id: 'ask',
              label: 'Create with Shibaox',
              hint: 'describe it in a sentence',
              icon: 'zap',
            },
            {
              id: 'manual',
              label: 'Set up manually',
              hint: 'the form, field by field',
              icon: 'settings',
            },
            {
              id: 'template',
              label: 'From a template',
              hint: 'security scan, briefing, triage…',
              icon: 'file-text',
            },
          ]}
          onSelect={(id) => {
            if (id === 'ask') setDialog({ kind: 'ask' });
            else if (id === 'manual') setDialog({ kind: 'create', form: EMPTY_FORM });
            else setTemplates(true);
          }}
        />
      </div>
      <div className="page sx-scroll">
        <p className="muted">Run work on a schedule, on a trigger, or whenever you need it.</p>
        <div className="row">
          <S.Input
            type="search"
            icon="search"
            placeholder="Search routines"
            aria-label="Search routines"
            value={query}
            onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <span className="grow" />
          <S.Menu
            open={sortOpen}
            onClose={() => setSortOpen(false)}
            align="end"
            anchor={
              <S.Button
                size="sm"
                variant="quiet"
                iconRight="chevron-down"
                onClick={() => setSortOpen((o) => !o)}
              >
                {`Sort by: ${SORTS.find((s) => s.id === sort)?.label}`}
              </S.Button>
            }
            items={SORTS.map((s) => ({ id: s.id, label: s.label, checked: s.id === sort }))}
            onSelect={(id) => setSort(id as Sort)}
          />
        </div>
        {routines.length === 0 ? (
          <div className="empty">
            <h2>Nothing scheduled</h2>
            <p>A routine runs a workflow on a schedule, or when something it watches changes.</p>
          </div>
        ) : null}
        <div className="routines">
          {shown.map((r) => (
            <RoutineCard
              key={r.id}
              r={r}
              onEdit={() =>
                setDialog({ kind: 'edit', id: r.id, form: formOf(r), fromOrg: r.source === 'org' })
              }
              onDuplicate={() =>
                setDialog({
                  kind: 'create',
                  form: { ...formOf(r), name: `${r.name ?? r.id} (copy)` },
                })
              }
              onRemove={() => setDialog({ kind: 'remove', r })}
            />
          ))}
        </div>
        {templates || routines.length === 0 ? (
          <div className="stack">
            <div className="row">
              <h3>Start from a template</h3>
              <span className="grow" />
              {routines.length > 0 ? (
                <S.Button size="sm" variant="quiet" onClick={() => setTemplates(false)}>
                  Hide
                </S.Button>
              ) : null}
            </div>
            <div className="routines">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="template"
                  onClick={() =>
                    setDialog({
                      kind: 'create',
                      form: { ...EMPTY_FORM, ...t.draft, approvals: t.draft.approvals ?? 'inbox' },
                    })
                  }
                >
                  <S.Card icon={t.icon} title={t.title} description={t.description} interactive>
                    <span className="muted">{triggerWords(t.draft.trigger)}</span>
                  </S.Card>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {dialog?.kind === 'create' ? (
        <RoutineDialog
          title="Create routine"
          initial={dialog.form}
          onSave={save()}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'edit' ? (
        <RoutineDialog
          title="Edit routine"
          initial={dialog.form}
          fromOrg={dialog.fromOrg}
          onSave={save(dialog.id)}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'ask' ? (
        <S.Dialog
          open
          title="Create with Shibaox"
          description="Say what to watch and what to do; a draft opens for you to check and save."
          icon="zap"
          onClose={() => setDialog(undefined)}
          footer={
            <>
              <S.Button variant="quiet" onClick={() => setDialog(undefined)}>
                Cancel
              </S.Button>
              <S.Button
                variant="primary"
                disabled={!sentence.trim()}
                loading={drafting}
                onClick={() => {
                  setDrafting(true);
                  void store.draftRoutine(sentence.trim()).then((d) => {
                    setDrafting(false);
                    if (!d) return;
                    setDialog({
                      kind: 'create',
                      form: {
                        ...EMPTY_FORM,
                        name: d.name,
                        description: d.description,
                        input: d.input,
                        trigger: d.trigger,
                        workflow: d.workflow,
                        approvals: d.approvals ?? 'inbox',
                      },
                    });
                  });
                }}
              >
                Draft it
              </S.Button>
            </>
          }
        >
          <S.Textarea
            label="Describe what to watch and what to do"
            placeholder="Every weekday at 9, tell me what changed in the repo yesterday."
            rows={3}
            value={sentence}
            onChange={(e) => setSentence((e.target as HTMLTextAreaElement).value)}
          />
        </S.Dialog>
      ) : null}
      {dialog?.kind === 'remove' ? (
        <S.Dialog
          open
          title="Remove routine?"
          description={`${dialog.r.name ?? dialog.r.id} stops for good; its past runs stay in Chats.`}
          icon="triangle-alert"
          width={440}
          onClose={() => setDialog(undefined)}
          footer={
            <>
              <S.Button variant="quiet" onClick={() => setDialog(undefined)}>
                Cancel
              </S.Button>
              <S.Button
                variant="danger"
                onClick={() => {
                  const id = dialog.r.id;
                  setDialog(undefined);
                  void store.removeRoutine(id);
                }}
              >
                Remove
              </S.Button>
            </>
          }
        />
      ) : null}
    </main>
  );
}
