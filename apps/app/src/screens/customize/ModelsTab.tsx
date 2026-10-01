import type { DecisionsView } from '@wizardingcode/shibaox-daemon';
import type { ModelChoice } from '@wizardingcode/shibaox-providers';
import { useState } from 'react';
import { ds } from '../../ds.js';
import { useAppState, useStore } from '../../store/hooks.js';
import { matches } from './filter.js';
import { goToKey } from './parts.js';

type Filter = 'all' | 'ready' | 'key' | 'runtime' | 'local';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready' },
  { id: 'key', label: 'Missing key' },
  { id: 'runtime', label: 'Missing runtime' },
  { id: 'local', label: 'Local' },
];

/** Where a model stands: usable, a key to set, a runtime or a server that is not there. */
export function modelState(m: ModelChoice): 'ready' | 'key' | 'runtime' {
  if (m.local) return m.available ? 'ready' : 'runtime';
  if (m.configured) return 'ready';
  return m.missing?.length ? 'key' : 'runtime';
}
const keep = (m: ModelChoice, f: Filter) =>
  f === 'all' ? true : f === 'local' ? m.local === true : modelState(m) === f;

const context = (n?: number) =>
  n === undefined
    ? '—'
    : n >= 1_000_000
      ? `${Math.round(n / 100_000) / 10}M`
      : `${Math.round(n / 1000)}k`;
const price = (m: ModelChoice) =>
  m.free || m.local
    ? 'free'
    : m.pricing
      ? `$${m.pricing.input_per_m} / $${m.pricing.output_per_m}`
      : '—';

function ModelStatus(props: { m: ModelChoice }): JSX.Element {
  const S = ds();
  const m = props.m;
  const st = modelState(m);
  if (st === 'ready') return <S.Badge tone="matcha">{m.local ? 'local, up' : 'ready'}</S.Badge>;
  if (st === 'key') {
    const key = m.missing?.[0] ?? '';
    return (
      <button
        type="button"
        className="badge-link"
        aria-label={`${key} missing`}
        onClick={() => goToKey(key)}
      >
        <S.Badge tone="warning" icon="key">
          {`missing ${(m.missing ?? []).join(', ')}`}
        </S.Badge>
      </button>
    );
  }
  return (
    <S.Badge>{m.local ? 'local, down' : `no runtime${m.runtime ? ` (${m.runtime})` : ''}`}</S.Badge>
  );
}

const TIERS: { id: 'strong' | 'cheap' | 'decision'; label: string }[] = [
  { id: 'strong', label: 'Strong' },
  { id: 'cheap', label: 'Cheap' },
  { id: 'decision', label: 'Decision' },
];

/** The org's tiers, judge and budget per run (`PUT /orgs/config`). */
function Tiers(): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const config = state.customize?.config;
  const [tiers, setTiers] = useState<Record<string, string>>({});
  const [judge, setJudge] = useState<string | undefined>(undefined);
  const [budget, setBudget] = useState<string | undefined>(undefined);
  const val = (id: string) =>
    tiers[id] ?? (config?.tiers as Record<string, string | undefined>)?.[id] ?? '';
  return (
    <form
      className="tiers"
      onSubmit={(e) => {
        e.preventDefault();
        const patch: Record<string, unknown> = {};
        const changed = Object.fromEntries(
          Object.entries(tiers)
            .filter(([, v]) => v.trim())
            .map(([k, v]) => [k, v.trim()]),
        );
        if (Object.keys(changed).length) patch.tiers = changed;
        if (judge !== undefined) patch.judge = judge.trim() || null;
        if (budget !== undefined)
          patch.per_run_usd = budget.trim() ? Number.parseFloat(budget) : null;
        if (Object.keys(patch).length) void store.saveOrgConfig(patch);
      }}
    >
      {TIERS.map((t) => (
        <S.Input
          key={t.id}
          label={t.label}
          placeholder="provider/model"
          value={val(t.id)}
          onChange={(e) => setTiers({ ...tiers, [t.id]: (e.target as HTMLInputElement).value })}
        />
      ))}
      <S.Input
        label="Judge"
        placeholder="provider/model (empty = the decision tier)"
        value={judge ?? config?.judge ?? ''}
        onChange={(e) => setJudge((e.target as HTMLInputElement).value)}
      />
      <S.Input
        label="Budget per run (USD)"
        value={budget ?? (config?.per_run_usd !== undefined ? String(config.per_run_usd) : '')}
        onChange={(e) => setBudget((e.target as HTMLInputElement).value)}
      />
      <div className="row tiers__save">
        <S.Button variant="primary" type="submit">
          Save tiers
        </S.Button>
      </div>
    </form>
  );
}

/** Who decides for the org, and the latest decisions with a way into their conversations. */
function Decisions(props: { view: DecisionsView }): JSX.Element {
  const S = ds();
  const { decider, decisions } = props.view;
  const who =
    decider.kind === 'model'
      ? `Decisions and the judge go through ${decider.ref}`
      : decider.kind === 'jev'
        ? `Decisions go through Jev, TypeSafe's typed API${decider.ref ? ` (${decider.ref})` : ''}`
        : 'No decider is configured';
  return (
    <div className="stack">
      <p className="muted">
        <span className="mono">{who}</span>
        {' · '}
        {decider.usable ? (
          <S.Badge tone="matcha">configured</S.Badge>
        ) : (
          <S.Badge tone="warning">not usable: {decider.reason}</S.Badge>
        )}
      </p>
      {decisions.length === 0 ? (
        <p className="muted">
          No decision yet. A chat has none: decide nodes and gates with a judge (hello-feature's
          judge, a review check) use the decider; the result shows here and in the Tasks tab of its
          conversation.
        </p>
      ) : (
        decisions.map((d) => (
          <a
            key={`${d.runId}:${d.nodeId}:${d.at}`}
            href={`#/t/${d.runId}`}
            className="row decision"
          >
            <span className="mono">{d.nodeId}</span>
            <span>{d.choice}</span>
            {d.confidence !== undefined ? (
              <span className="muted">{Math.round(d.confidence * 100)}%</span>
            ) : null}
            {d.by ? <span className="muted">by {d.by}</span> : null}
            <span className="grow" />
            <span className="muted">{new Date(d.at).toLocaleString()}</span>
          </a>
        ))
      )}
    </div>
  );
}

/** Models: the tiers on top, every model with its status, the decisions at the bottom. */
export function ModelsTab(): JSX.Element {
  const S = ds();
  const state = useAppState();
  const c = state.customize;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  if (!c) return <p className="muted">Reading the org…</p>;
  const rows = c.models.filter((m) => keep(m, filter) && matches(query, [m.ref, m.provider]));
  return (
    <div className="stack-24">
      <section className="stack-12" aria-label="Tiers">
        <div className="stack">
          <h3>Tiers</h3>
          <span className="muted">
            Which model does strong work, cheap work, decisions and judging.
          </span>
        </div>
        {c.config ? <Tiers /> : <p className="muted">This org's config could not be read.</p>}
      </section>
      <section className="stack-12" aria-label="Models">
        <h3>Models</h3>
        <div className="toolbar">
          <S.Input
            type="search"
            icon="search"
            placeholder="Search models"
            aria-label="Search models"
            value={query}
            onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <span className="grow" />
          <S.Segmented
            label="Filter"
            items={FILTERS}
            value={filter}
            onChange={(id) => setFilter(id as Filter)}
          />
        </div>
        {rows.length ? (
          <S.Table
            dense
            columns={['Model', 'Provider', 'Status', 'Context', 'Price per M']}
            align={[null, null, null, 'right', 'right']}
            rows={rows.map((m) => [
              <span key="r" className="mono">
                {m.ref}
              </span>,
              <span key="p">{m.provider}</span>,
              <ModelStatus key="s" m={m} />,
              <span key="c">{context(m.contextWindow)}</span>,
              <span key="$">{price(m)}</span>,
            ])}
          />
        ) : (
          <p className="muted">No model matches.</p>
        )}
      </section>
      <section className="stack-12" aria-label="Decisions">
        <h3>Decisions</h3>
        {c.decisions ? (
          <Decisions view={c.decisions} />
        ) : (
          <p className="muted">Reading the daemon…</p>
        )}
      </section>
    </div>
  );
}
