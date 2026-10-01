import { useEffect, useMemo, useRef, useState } from 'react';
import { ds } from '../../ds.js';
import { useAppState, useStore } from '../../store/hooks.js';
import { matches } from './filter.js';
import { KEY_NAME_RE, type KeyLine, neededKeys } from './needed-keys.js';

/** Set: the masked value and where it comes from; missing: a badge. */
function Status(props: { k: KeyLine }): JSX.Element {
  const S = ds();
  const k = props.k;
  return k.set ? (
    <S.Badge tone="matcha">{['set', k.masked, k.source].filter(Boolean).join(' · ')}</S.Badge>
  ) : (
    <S.Badge tone="warning">missing</S.Badge>
  );
}

/** Set (a password field and Save), Unset (vault only), or "from the environment". */
function Action(props: { k: KeyLine }): JSX.Element {
  const S = ds();
  const store = useStore();
  const [value, setValue] = useState('');
  const k = props.k;
  if (k.via) return <span className="muted">{`through ${k.via}`}</span>;
  if (k.set)
    return k.source === 'env' ? (
      <span className="muted">from the environment</span>
    ) : (
      <S.Button
        size="sm"
        variant="quiet"
        aria-label={`Unset ${k.name}`}
        onClick={() => void store.unsetKey(k.name)}
      >
        Unset
      </S.Button>
    );
  return (
    <form
      className="key-set"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        void store.setKey(k.name, value.trim());
        setValue('');
      }}
    >
      <S.Input
        type="password"
        aria-label={k.name}
        placeholder="Paste the key"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue((e.target as HTMLInputElement).value)}
      />
      <S.Button size="sm" type="submit" disabled={!value.trim()}>
        Save
      </S.Button>
    </form>
  );
}

function Name(props: { k: KeyLine; focus?: string }): JSX.Element {
  const k = props.k;
  const focused = k.name === props.focus || (k.alternatives ?? []).includes(props.focus ?? '');
  return (
    <span className={focused ? 'mono key-focus' : 'mono'} data-key={k.name}>
      {k.name}
      {(k.alternatives ?? []).map((a) => (
        <span key={a} data-key={a}>
          <span className="muted"> or </span>
          {a}
        </span>
      ))}
    </span>
  );
}

function NeededBy(props: { k: KeyLine }): JSX.Element {
  const S = ds();
  return (
    <span className="badges">
      {props.k.neededBy.map((b) => (
        <S.Badge key={b.label}>{b.label}</S.Badge>
      ))}
    </span>
  );
}

/** Other: add a key of your own (a valid env name and its value). */
function AddKey(): JSX.Element {
  const S = ds();
  const store = useStore();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const valid = KEY_NAME_RE.test(name.trim());
  return (
    <form
      className="key-set"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || !value) return;
        void store.setKey(name.trim(), value);
        setName('');
        setValue('');
      }}
    >
      <S.Input
        aria-label="New key name"
        placeholder="NAME_OF_THE_KEY"
        value={name}
        error={name && !valid ? 'Capitals, digits and _' : undefined}
        onChange={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <S.Input
        type="password"
        aria-label="New key value"
        placeholder="Its value"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue((e.target as HTMLInputElement).value)}
      />
      <S.Button size="sm" type="submit" icon="plus" disabled={!valid || !value}>
        Add key
      </S.Button>
    </form>
  );
}

/** Keys: what is needed now, the providers, and the rest of the vault. */
export function KeysTab(props: { focus?: string }): JSX.Element {
  const S = ds();
  const state = useAppState();
  const c = state.customize;
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const blocks = useMemo(
    () =>
      c
        ? neededKeys({
            config: c.config,
            roles: c.roles,
            mcp: c.mcp,
            plugins: c.plugins,
            models: c.models,
            keys: c.keys,
          })
        : undefined,
    [c],
  );
  const hit = (k: KeyLine) =>
    matches(query, [
      k.name,
      ...(k.alternatives ?? []),
      k.description,
      ...k.neededBy.map((b) => b.label),
      ...k.models,
    ]);
  // ?key=NAME: that row's field gets the focus (the first block that has it), else its name scrolls in
  const loaded = blocks !== undefined;
  useEffect(() => {
    if (!props.focus || !loaded) return;
    const el = root.current;
    const name = props.focus.replace(/["\\]/g, '\\$&');
    const input = el?.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);
    const target = input ?? el?.querySelector<HTMLElement>(`[data-key="${name}"]`);
    try {
      target?.scrollIntoView?.({ block: 'center' });
    } catch {
      // no layout (tests)
    }
    input?.focus({ preventScroll: true });
  }, [props.focus, loaded]);
  if (!blocks) return <p className="muted">Reading the vault…</p>;
  const needed = blocks.needed.filter(hit);
  const providers = blocks.providers
    .filter((k) => all || k.set || k.neededBy.length > 0)
    .filter(hit);
  const other = blocks.other.filter(hit);
  return (
    <div className="stack-24" ref={root}>
      <div className="toolbar">
        <S.Input
          type="search"
          icon="search"
          placeholder="Search keys"
          aria-label="Search keys"
          value={query}
          onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>
      <section className="stack-12" aria-label="Needed now">
        <div className="stack">
          <h3>Needed now</h3>
          <span className="muted">
            Keys the org's tiers, its roles' models, its connectors and the plugins read.
          </span>
        </div>
        {needed.length ? (
          <S.Table
            dense
            className="keys-table"
            columns={['Key', 'Needed by', 'Status', '']}
            rows={needed.map((k) => [
              <Name key="n" k={k} focus={props.focus} />,
              <NeededBy key="b" k={k} />,
              <Status key="s" k={k} />,
              <Action key="a" k={k} />,
            ])}
          />
        ) : (
          <p className="muted">
            {query.trim()
              ? `Nothing matches “${query.trim()}”.`
              : 'Nothing in this org needs a key.'}
          </p>
        )}
      </section>
      <section className="stack-12" aria-label="Providers">
        <div className="row">
          <div className="stack">
            <h3>Providers</h3>
            <span className="muted">One key per model provider; the count is what it unlocks.</span>
          </div>
          <span className="grow" />
          <S.Switch label="Show all providers" checked={all} onChange={setAll} />
        </div>
        {providers.length ? (
          <S.Table
            dense
            className="keys-table"
            columns={['Provider', 'Key', 'Status', 'Models', '']}
            align={[null, null, null, 'right', null]}
            rows={providers.map((k) => [
              <span key="p">{k.description}</span>,
              <Name key="n" k={k} focus={props.focus} />,
              <Status key="s" k={k} />,
              <span key="m" title={k.models.join('\n') || undefined}>
                {k.models.length}
              </span>,
              <Action key="a" k={k} />,
            ])}
          />
        ) : (
          <p className="muted">No provider key set yet: Show all providers lists them.</p>
        )}
      </section>
      <section className="stack-12" aria-label="Other">
        <div className="stack">
          <h3>Other</h3>
          <span className="muted">
            Shibaox's own keys (Telegram, GitHub, the daemon token, TypeSafe) and yours.
          </span>
        </div>
        {other.length ? (
          <S.Table
            dense
            className="keys-table"
            columns={['Key', 'What for', 'Status', '']}
            rows={other.map((k) => [
              <Name key="n" k={k} focus={props.focus} />,
              <span key="d">{k.description}</span>,
              <Status key="s" k={k} />,
              <Action key="a" k={k} />,
            ])}
          />
        ) : null}
        <AddKey />
      </section>
    </div>
  );
}
