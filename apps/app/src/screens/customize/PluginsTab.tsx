import type { ConnectorTemplate, PluginRow } from '@wizardingcode/shibaox-daemon';
import { useState } from 'react';
import { ds } from '../../ds.js';
import { useAppState, useStore } from '../../store/hooks.js';
import { ApiKeyDialog, HIGGSFIELD_KEY } from './dialogs/ApiKeyDialog.js';
import { TemplateDialog } from './dialogs/ConnectorDialog.js';
import { RolesDialog } from './dialogs/RolesDialog.js';
import { matches } from './filter.js';
import { BrandLogo } from './logos.js';
import { pluginKeyNeeds } from './needed-keys.js';
import { AddMenu, Empty, goTo, KeyBadge, TokenPaste, Toolbar } from './parts.js';
import { settle } from './skill-results.js';
import type { CustomizeView, HiggsfieldEffective, HiggsfieldMode, PluginMode } from './types.js';

const STATUS: Record<
  PluginRow['status'],
  { tone: 'matcha' | 'warning' | 'neutral'; label: string }
> = {
  ready: { tone: 'matcha', label: 'Ready' },
  partial: { tone: 'warning', label: 'Needs setup' },
  off: { tone: 'neutral', label: 'Not set up' },
};

/** "Use for generation": what the daemon.yaml choice can be. */
const MODE_OPTIONS: { id: HiggsfieldMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'the API when a key is saved, else the account' },
  { id: 'account', label: 'Account', hint: 'your login and plan credits' },
  { id: 'api', label: 'API', hint: 'your developer key' },
];
const NOW: Record<HiggsfieldEffective, string> = {
  api: 'Now: API',
  account: 'Now: Account',
  none: 'Now: nothing set up',
};

/** TypeSafe's actions: POSTed, and they write the org (the decision tier, routing). */
const ORG_ACTIONS: ReadonlySet<string> = new Set(['use_jev', 'routing_on', 'routing_off']);

/** What a body shows: the plugin itself, or one of its modes (`id` is the mode's). */
type Part = Pick<PluginRow, 'checks' | 'keys' | 'actions' | 'brings'> & { id?: string };

/** A plugin's (or a mode's) checks, actions and what it brings. */
function PluginBody(props: {
  p: PluginRow;
  part: Part;
  onConnector: (t: ConnectorTemplate) => void;
  onSkillAdded: (id: string, name: string) => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const c = state.customize;
  const p = props.p;
  const part = props.part;
  // the command an install action copies; shown whole while the CLI is not there
  const installCommand = part.actions.find((a) => a.id === 'install' && a.command)?.command;
  const cliMissing = part.checks.some((ch) => /^CLI installed/.test(ch.label) && !ch.ok);
  // every key of this part is missing (alternatives such as GH_TOKEN or GITHUB_TOKEN count as one)
  const missingKeys = part.keys.some((k) => k.present) ? [] : part.keys.map((k) => k.name);
  const [login, setLogin] = useState<{ url?: string } | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState<string | undefined>(undefined);
  const [keyDialog, setKeyDialog] = useState(false);
  // a POSTed action (Telegram's pair / test): the one in flight and what it ended with
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const post = (id: string) => {
    setBusy(id);
    setOutcome(undefined);
    void store.pluginAction(p.id, id).then((r) => {
      setBusy(undefined);
      setOutcome(actionOutcome(id, r));
      // TypeSafe's actions change the org (decision tier, routing): tiers and decisions too
      if (r.ok && ORG_ACTIONS.has(id)) void store.loadCustomize();
    });
  };
  // Connect vs Manage: the part's own key first, else the vault row (label and dialog agree)
  const keyPresent =
    part.keys.find((k) => k.name === HIGGSFIELD_KEY)?.present ??
    c?.keys.find((k) => k.name === HIGGSFIELD_KEY)?.set === true;
  const builtin = part.brings.builtin ?? [];
  const skills = [...new Set([...part.brings.skills, ...builtin])];
  const tools = part.brings.tools ?? [];
  /** A skill the plugin brings: from Shibaox's own template, else the vendor's skill source. */
  const addSkill = (id: string) => {
    const own = (s: string) => s.toLowerCase();
    const src = (c?.registry.skills ?? []).find(
      (s) => own(s.vendor) === own(p.name) || own(s.vendor) === own(p.id),
    );
    if (!builtin.includes(id) && !src) return goTo('skills', 'discover');
    setAdding(id);
    void store
      .addSkill(
        builtin.includes(id) || !src
          ? { source: 'builtin', id }
          : {
              source: 'repo',
              repo: src.repo,
              ...(src.path ? { path: src.path } : {}),
              ids: [id],
            },
      )
      .then((r) => {
        setAdding(undefined);
        if (!r) return;
        const skipped = settle(r, {
          close: () => undefined,
          onAdded: (added) => {
            const first = added[0];
            if (first) props.onSkillAdded(first.id, first.name);
          },
          notice: (m) => store.notice(m),
        });
        if (skipped.length) store.notice(`Not added: ${skipped.join('; ')}`);
      });
  };
  const install = (command: string) => {
    try {
      void navigator.clipboard?.writeText(command);
    } catch {
      // no clipboard
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  /**
   * An action: `login` POSTs through the store (its href is a daemon path, never a link),
   * `pair` / `test` POST the plugin's action (a loading button, the outcome inline),
   * `use_jev` / `routing_on` / `routing_off` POST TypeSafe's action (they write the org),
   * `connect_key` opens the key dialog, an absolute http(s) href opens apart, `install` copies
   * its command; anything else is hidden.
   */
  const action = (a: Part['actions'][number]) => {
    if (a.id === 'login')
      return (
        <S.Button
          key={a.id}
          size="sm"
          variant="primary"
          onClick={() =>
            void store.higgsfieldLogin().then((r) => {
              if (r) setLogin(r);
            })
          }
        >
          {a.label}
        </S.Button>
      );
    if (a.id === 'pair' || a.id === 'test' || ORG_ACTIONS.has(a.id))
      return (
        <S.Button
          key={a.id}
          size="sm"
          variant={a.id === 'pair' || a.id === 'use_jev' ? 'primary' : 'secondary'}
          loading={busy === a.id}
          disabled={busy !== undefined}
          onClick={() => post(a.id)}
        >
          {a.label}
        </S.Button>
      );
    if (a.id === 'connect_key')
      return (
        <S.Button key={a.id} size="sm" variant="primary" onClick={() => setKeyDialog(true)}>
          {keyPresent ? 'Manage API key' : 'Connect API key'}
        </S.Button>
      );
    if (a.href && /^https?:\/\//i.test(a.href))
      return (
        <a
          key={a.id}
          className="sx-btn sx-btn--secondary sx-btn--sm"
          href={a.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {a.label}
        </a>
      );
    const command = a.id === 'install' ? a.command : undefined;
    if (!command) return null;
    return (
      <S.Button key={a.id} size="sm" variant="secondary" onClick={() => install(command)}>
        {copied ? 'Copied' : a.label}
      </S.Button>
    );
  };
  const validity = part.checks.find((ch) => ch.label === 'API key valid');
  return (
    <div className="stack-12">
      {part.checks.length ? (
        <ul className="checklist">
          {part.checks.map((ch) => (
            <li key={ch.label}>
              <span className={ch.ok ? 'ok' : 'bad'}>
                <S.Icon name={ch.ok ? 'check-circle' : 'triangle-alert'} size={16} />
              </span>
              <span className="checklist__label">{ch.label}</span>
              {ch.detail ? <span className="muted checklist__detail">{ch.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {cliMissing && installCommand ? (
        <S.CodeBlock language="bash" code={installCommand}>
          {installCommand}
        </S.CodeBlock>
      ) : null}
      {missingKeys.length && !part.actions.some((a) => a.id === 'connect_key') ? (
        <TokenPaste name={missingKeys[0] ?? ''} alternatives={missingKeys} />
      ) : null}
      <div className="row">
        {part.actions.map(action)}
        <S.Button size="sm" variant="quiet" onClick={() => void store.loadCustomize()}>
          Check again
        </S.Button>
      </div>
      {busy === 'pair' ? (
        <p className="muted" role="status">
          Open your bot in Telegram and send /start now (waiting up to 60 s)…
        </p>
      ) : null}
      {outcome ? (
        <p className={outcome.ok ? 'muted' : 'note note--danger'} role="status">
          {outcome.text}
        </p>
      ) : null}
      {login?.url ? (
        <p className="muted">
          Finish the login here:{' '}
          <a href={login.url} target="_blank" rel="noopener noreferrer">
            {login.url}
          </a>
        </p>
      ) : null}
      {part.brings.connectors.length + skills.length + tools.length > 0 ? (
        <div className="row">
          <span className="muted">Brings</span>
          {part.brings.connectors.map((id) =>
            c?.mcp.some((m) => m.id === id) ? (
              <S.Badge key={`c-${id}`} tone="matcha" icon="check">
                {`connector ${id}`}
              </S.Badge>
            ) : (
              <S.Button
                key={`c-${id}`}
                size="sm"
                variant="quiet"
                icon="plus"
                aria-label={`Add connector ${id}`}
                onClick={() => {
                  const t = c?.registry.connectors.find((x) => x.id === id);
                  if (t) props.onConnector(t);
                  else goTo('connectors', 'discover');
                }}
              >
                {`connector ${id}`}
              </S.Button>
            ),
          )}
          {skills.map((id) =>
            c?.skills.some((s) => s.id === id) ? (
              <S.Badge key={`s-${id}`} tone="matcha" icon="check">
                {`skill ${id}`}
              </S.Badge>
            ) : (
              <S.Button
                key={`s-${id}`}
                size="sm"
                variant="quiet"
                icon="plus"
                loading={adding === id}
                aria-label={`Add skill ${id}`}
                onClick={() => addSkill(id)}
              >
                {`skill ${id}`}
              </S.Button>
            ),
          )}
          {tools.map((id) => (
            <S.Badge key={`t-${id}`}>{`tool ${id}`}</S.Badge>
          ))}
        </div>
      ) : null}
      {p.id === 'higgsfield' && (!p.modes?.length || part.id === 'account') ? (
        <p className="muted">
          Ask Shibaox for an image, a video or a voice: it generates it with your Higgsfield credits
          and saves the file in the conversation. Create an account is an affiliate link: Shibaox's
          maintainer earns a share, you pay the same.
        </p>
      ) : null}
      {p.id === 'higgsfield' && part.id === 'api' ? (
        <p className="muted">
          Shibaox calls the Higgsfield API with your key: generation is billed to your Higgsfield
          developer account (open.higgsfield.ai), not to your plan's credits. The key stays in the
          daemon's vault.
        </p>
      ) : null}
      {p.id === 'typesafe' ? (
        <p className="muted">
          Jev decides decide nodes, routes every chat turn (what it asks for, whether it is risky,
          whether the cheap tier is enough) and runs jev checks, each with a confidence. A call
          costs a fraction of a cent, added to the run's spend.
        </p>
      ) : null}
      {keyDialog ? (
        <ApiKeyDialog
          present={keyPresent}
          {...(validity ? { validity: { ok: validity.ok, detail: validity.detail } } : {})}
          onClose={() => setKeyDialog(false)}
        />
      ) : null}
    </div>
  );
}

/** What a POSTed action ended with, in one line: the paired chat, Sent ✓, or the reason. */
function actionOutcome(
  id: string,
  r: { ok: true; result: unknown } | { ok: false; error: string },
): { ok: boolean; text: string } {
  if (!r.ok) return { ok: false, text: r.error };
  const v = (r.result ?? {}) as { paired?: boolean; chatId?: number; reason?: string };
  if (id === 'pair')
    return v.paired
      ? { ok: true, text: `Paired with chat ${v.chatId}` }
      : { ok: false, text: v.reason ?? 'Not paired' };
  if (id === 'test') return { ok: true, text: 'Sent ✓' };
  if (id === 'use_jev') return { ok: true, text: 'Jev decides now' };
  if (id === 'routing_on') return { ok: true, text: 'Jev routes requests now' };
  if (id === 'routing_off') return { ok: true, text: 'Routing is off' };
  return { ok: true, text: 'Done' };
}

/** The modes of a plugin (Higgsfield: Account | API), what generation uses, and the chosen panel. */
function PluginModes(props: {
  p: PluginRow;
  modes: PluginMode[];
  onConnector: (t: ConnectorTemplate) => void;
  onSkillAdded: (id: string, name: string) => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const p = props.p;
  const first = props.modes.find((m) => m.active) ?? props.modes[0];
  const configured = p.mode?.configured;
  const chosen = props.modes.find((m) => m.id === configured);
  const [shown, setShown] = useState((chosen ?? first)?.id ?? '');
  // a new choice shows its panel (a re-read of the same choice does not); the Segmented still switches
  const [seen, setSeen] = useState(configured);
  if (configured !== seen) {
    setSeen(configured);
    if (chosen) setShown(chosen.id);
  }
  const mode = props.modes.find((m) => m.id === shown) ?? first;
  /** The mode generation uses now (the daemon's effective one, else the active one). */
  const inUse = (m: PluginMode) => (p.mode ? p.mode.effective === m.id : m.active);
  return (
    <div className="stack-12">
      <div className="row">
        <S.Segmented
          label="Mode"
          items={props.modes.map((m) => ({
            id: m.id,
            label: m.name,
            ...(inUse(m) ? { dot: true, dotLabel: 'in use' } : {}),
          }))}
          value={mode?.id ?? ''}
          onChange={setShown}
        />
        <span className="grow" />
        {p.mode ? <span className="muted">{NOW[p.mode.effective]}</span> : null}
      </div>
      {p.mode ? (
        <S.Select
          label="Use for generation"
          value={p.mode.configured}
          options={MODE_OPTIONS}
          onChange={(id) => {
            if (id !== p.mode?.configured) void store.setHiggsfieldMode(id as HiggsfieldMode);
          }}
        />
      ) : null}
      {mode ? (
        <>
          <div className="row">
            <span className="muted">{mode.description}</span>
            <span className="grow" />
            <S.Badge tone={STATUS[mode.status].tone} dot>
              {STATUS[mode.status].label}
            </S.Badge>
          </div>
          <PluginBody
            key={mode.id}
            p={p}
            part={mode}
            onConnector={props.onConnector}
            onSkillAdded={props.onSkillAdded}
          />
        </>
      ) : null}
    </div>
  );
}

/** One plugin: its status, and its body (or its modes, each with its own body). */
function PluginCard(props: {
  p: PluginRow;
  onConnector: (t: ConnectorTemplate) => void;
  onSkillAdded: (id: string, name: string) => void;
}): JSX.Element {
  const S = ds();
  const p = props.p;
  const st = STATUS[p.status];
  return (
    <S.Card
      logo={<BrandLogo id={p.id} name={p.name} />}
      title={p.name}
      description={p.description}
      meta={
        <>
          <S.Badge tone={st.tone} dot>
            {st.label}
          </S.Badge>
          {pluginKeyNeeds(p).map((n) => (
            <KeyBadge
              key={n.names.join('|')}
              name={n.names.join(' or ')}
              focus={n.names[0]}
              present={n.present}
            />
          ))}
        </>
      }
    >
      {p.modes?.length ? (
        <PluginModes
          p={p}
          modes={p.modes}
          onConnector={props.onConnector}
          onSkillAdded={props.onSkillAdded}
        />
      ) : (
        <PluginBody
          p={p}
          part={p}
          onConnector={props.onConnector}
          onSkillAdded={props.onSkillAdded}
        />
      )}
    </S.Card>
  );
}

/** Yours: something set up, a mode set up, or a generation choice made (API before its key). */
function isYours(p: PluginRow): boolean {
  return (
    p.status !== 'off' ||
    p.modes?.some((m) => m.status !== 'off') === true ||
    (p.mode !== undefined && p.mode.configured !== 'auto')
  );
}

/** What search reads: the plugin's words, keys and checks, and its modes'. */
function searchText(p: PluginRow): string[] {
  const parts = [p, ...(p.modes ?? [])];
  return [
    p.id,
    p.name,
    p.description,
    ...(p.modes ?? []).flatMap((m) => [m.name, m.description]),
    ...parts.flatMap((x) => [...x.keys.map((k) => k.name), ...x.checks.map((ch) => ch.label)]),
  ];
}

/** Plugins: partner integrations with their own setup (built in; Yours = something configured). */
export function PluginsTab(props: { view: CustomizeView }): JSX.Element {
  const state = useAppState();
  const c = state.customize;
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<
    | { kind: 'connector'; template: ConnectorTemplate }
    | { kind: 'roles'; id: string; name: string }
    | undefined
  >(undefined);
  const plugins = c?.plugins ?? [];
  const discover = props.view === 'discover';
  const rows = plugins
    .filter((p) => (discover ? !isYours(p) : isYours(p)))
    .filter((p) => matches(query, searchText(p)));
  return (
    <>
      <Toolbar
        view={{
          value: props.view,
          dot: plugins.some((p) => p.status === 'partial'),
          onChange: (v) => goTo('plugins', v),
        }}
        search={{ label: 'Search plugins', value: query, onChange: setQuery }}
        add={
          <AddMenu
            items={[
              {
                id: 'info',
                label: 'Plugins are built in',
                hint: 'set one up from its card',
                icon: 'info',
                disabled: true,
              },
              { id: '-', label: '' },
              { id: 'connector', label: 'Add a connector', icon: 'plug' },
              { id: 'skill', label: 'Add a skill', icon: 'sparkles' },
            ]}
            onSelect={(id) =>
              id === 'connector' ? goTo('connectors', 'discover') : goTo('skills', 'discover')
            }
          />
        }
      />
      {!c ? <p className="muted">Reading the daemon…</p> : null}
      {c && rows.length === 0 ? (
        <Empty>
          {query.trim()
            ? `Nothing matches “${query.trim()}”.`
            : discover
              ? 'Every plugin is set up.'
              : 'No plugin is set up yet. Discover shows what Shibaox works with.'}
        </Empty>
      ) : null}
      {rows.length ? (
        <div className="grid-2">
          {rows.map((p) => (
            <PluginCard
              key={p.id}
              p={p}
              onConnector={(t) => setDialog({ kind: 'connector', template: t })}
              onSkillAdded={(id, name) => setDialog({ kind: 'roles', id, name })}
            />
          ))}
        </div>
      ) : null}
      {dialog?.kind === 'connector' ? (
        <TemplateDialog
          template={dialog.template}
          roles={c?.roles ?? []}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'roles' ? (
        <RolesDialog
          kind="skills"
          id={dialog.id}
          name={dialog.name}
          roles={c?.roles ?? []}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </>
  );
}
