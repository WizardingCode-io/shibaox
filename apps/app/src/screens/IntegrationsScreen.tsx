import type { DecisionsView, KeyRow, McpServerRow } from '@wizardingcode/shibaox-daemon';
import { useEffect, useState } from 'react';
import { ds } from '../ds.js';
import { useAppState, useStore } from '../store/hooks.js';

function McpCard(props: { row: McpServerRow }): JSX.Element {
  const S = ds();
  const store = useStore();
  const [result, setResult] = useState<
    { ok: boolean; tools?: { name: string; description: string }[]; error?: string } | undefined
  >(undefined);
  const [testing, setTesting] = useState(false);
  const missing = props.row.keys.filter((k) => !k.present).map((k) => k.name);
  return (
    <S.Card
      icon="plug"
      title={props.row.id}
      description={`${props.row.description} · ${props.row.transport} · ${props.row.target}`}
      action={
        <S.Button
          size="sm"
          loading={testing}
          onClick={() => {
            setTesting(true);
            void store.testMcp(props.row.id).then((r) => {
              setResult(r);
              setTesting(false);
            });
          }}
        >
          Test
        </S.Button>
      }
      footer={
        <div className="stack">
          <div className="row muted">
            <span>
              {props.row.roles.length
                ? `roles: ${props.row.roles.join(', ')}`
                : 'no role lists it yet'}
            </span>
            {props.row.tools ? <span>· only {props.row.tools.join(', ')}</span> : null}
            {missing.length ? <S.Badge tone="warning">missing {missing.join(', ')}</S.Badge> : null}
          </div>
          {result ? (
            result.ok ? (
              <span className="muted">
                {result.tools?.length ?? 0} tools:{' '}
                {(result.tools ?? []).map((t) => t.name).join(', ')}
              </span>
            ) : (
              <S.Badge tone="danger">{result.error ?? 'failed'}</S.Badge>
            )
          ) : null}
        </div>
      }
    />
  );
}

function KeyLine(props: { row: KeyRow }): JSX.Element {
  const S = ds();
  const store = useStore();
  const [value, setValue] = useState('');
  return (
    <div className="row">
      <div style={{ minWidth: 220 }}>
        <span className="mono">{props.row.name}</span>
        <div className="muted">{props.row.description}</div>
      </div>
      {props.row.set ? (
        <>
          <S.Badge tone="matcha">
            {props.row.masked ?? 'set'}
            {props.row.source === 'env' ? ' (env)' : ''}
          </S.Badge>
          {props.row.source !== 'env' ? (
            <S.Button size="sm" variant="quiet" onClick={() => void store.unsetKey(props.row.name)}>
              Unset
            </S.Button>
          ) : null}
        </>
      ) : (
        <>
          <S.Input
            aria-label={props.row.name}
            type="password"
            placeholder="Paste the key"
            value={value}
            onChange={(e) => setValue((e.target as HTMLInputElement).value)}
          />
          <S.Button
            size="sm"
            disabled={!value.trim()}
            onClick={() => {
              void store.setKey(props.row.name, value.trim());
              setValue('');
            }}
          >
            Set
          </S.Button>
        </>
      )}
    </div>
  );
}

const TIERS: { id: 'strong' | 'cheap' | 'decision'; label: string }[] = [
  { id: 'strong', label: 'Strong' },
  { id: 'cheap', label: 'Cheap' },
  { id: 'decision', label: 'Decision' },
];

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

function Tiers(): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const config = state.integrations?.config;
  const [tiers, setTiers] = useState<Record<string, string>>({});
  const [judge, setJudge] = useState<string | undefined>(undefined);
  const [budget, setBudget] = useState<string | undefined>(undefined);
  const val = (id: string) =>
    tiers[id] ?? (config?.tiers as Record<string, string | undefined>)?.[id] ?? '';
  return (
    <form
      className="stack"
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
      <div className="row">
        <S.Button variant="primary" type="submit">
          Save tiers
        </S.Button>
      </div>
    </form>
  );
}

/** MCP servers, providers and models, keys, tiers. */
export function IntegrationsScreen(): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  useEffect(() => {
    void store.loadIntegrations();
  }, [store]);
  const i = state.integrations;
  return (
    <main className="main">
      <div className="top">
        <h2>Integrations</h2>
        {i ? <span className="muted">{i.org}</span> : null}
      </div>
      <div className="page sx-scroll">
        <h3>MCP servers</h3>
        {i?.mcp.length === 0 ? (
          <p className="muted">No catalog entry of type mcp in this org.</p>
        ) : null}
        {(i?.mcp ?? []).map((row) => (
          <McpCard key={row.id} row={row} />
        ))}
        <h3>Models</h3>
        <div className="stack">
          {(i?.models ?? []).map((m) => (
            <div key={m.ref} className="row">
              <span className="mono">{m.ref}</span>
              <span className="grow" />
              {m.local ? (
                <S.Badge tone={m.available ? 'matcha' : 'neutral'}>
                  {m.available ? 'local, up' : 'local, down'}
                </S.Badge>
              ) : null}
              {!m.local ? (
                <S.Badge tone={m.configured ? 'matcha' : 'warning'}>
                  {m.configured ? 'configured' : `missing ${(m.missing ?? []).join(', ')}`}
                </S.Badge>
              ) : null}
            </div>
          ))}
        </div>
        <h3>Keys</h3>
        <div className="stack">
          {(i?.keys ?? []).map((k) => (
            <KeyLine key={k.name} row={k} />
          ))}
        </div>
        <h3>Decisions</h3>
        {i?.decisions ? (
          <Decisions view={i.decisions} />
        ) : (
          <p className="muted">Reading the daemon…</p>
        )}
        <h3>Tiers</h3>
        {i?.config ? <Tiers /> : <p className="muted">Reading the org…</p>}
      </div>
    </main>
  );
}
