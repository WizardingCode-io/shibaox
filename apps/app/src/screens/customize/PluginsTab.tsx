import type { ConnectorTemplate, PluginRow } from '@wizardingcode/shibaox-daemon';
import { useState } from 'react';
import { ds } from '../../ds.js';
import { useAppState, useStore } from '../../store/hooks.js';
import { TemplateDialog } from './dialogs/ConnectorDialog.js';
import { RolesDialog } from './dialogs/RolesDialog.js';
import { matches } from './filter.js';
import { pluginKeyNeeds } from './needed-keys.js';
import { AddMenu, Empty, goTo, KeyBadge, Toolbar } from './parts.js';
import { settle } from './skill-results.js';
import type { CustomizeView } from './types.js';

type IconName = Parameters<Window['Shibaox']['Icon']>[0]['name'];
const ICON: Record<string, IconName> = {
  higgsfield: 'image',
  github: 'github',
  telegram: 'message-square',
  typesafe: 'brain',
  jev: 'brain',
};
const STATUS: Record<
  PluginRow['status'],
  { tone: 'matcha' | 'warning' | 'neutral'; label: string }
> = {
  ready: { tone: 'matcha', label: 'Ready' },
  partial: { tone: 'warning', label: 'Needs setup' },
  off: { tone: 'neutral', label: 'Not set up' },
};

/** One plugin: its status, checks, keys, actions and what it brings. */
function PluginCard(props: {
  p: PluginRow;
  onConnector: (t: ConnectorTemplate) => void;
  onSkillAdded: (id: string, name: string) => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const c = state.customize;
  const p = props.p;
  const hf = p.id === 'higgsfield' ? c?.higgsfield : undefined;
  const [login, setLogin] = useState<{ url?: string } | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState<string | undefined>(undefined);
  const st = STATUS[p.status];
  /** A skill the plugin brings, from the skill source of the same vendor. */
  const addSkill = (id: string) => {
    const own = (s: string) => s.toLowerCase();
    const src = (c?.registry.skills ?? []).find(
      (s) => own(s.vendor) === own(p.name) || own(s.vendor) === own(p.id),
    );
    if (!src) return goTo('skills', 'discover');
    setAdding(id);
    void store
      .addSkill({
        source: 'repo',
        repo: src.repo,
        ...(src.path ? { path: src.path } : {}),
        ids: [id],
      })
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
   * An action: `login` POSTs through the store (its href is a daemon path, never a link), an
   * absolute http(s) href opens apart, `install` copies its command; anything else is hidden.
   */
  const action = (a: PluginRow['actions'][number]) => {
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
    const command = a.id === 'install' ? (a.command ?? hf?.installCommand) : undefined;
    if (!command) return null;
    return (
      <S.Button key={a.id} size="sm" variant="secondary" onClick={() => install(command)}>
        {copied ? 'Copied' : a.label}
      </S.Button>
    );
  };
  return (
    <S.Card
      icon={ICON[p.id] ?? 'package'}
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
      <div className="stack-12">
        {p.checks.length ? (
          <ul className="checklist">
            {p.checks.map((ch) => (
              <li key={ch.label}>
                <span className={ch.ok ? 'ok' : 'bad'}>
                  <S.Icon name={ch.ok ? 'check-circle' : 'triangle-alert'} size={16} />
                </span>
                <span>{ch.label}</span>
                {ch.detail ? <span className="muted">{ch.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {hf?.loggedIn && hf.account ? (
          <p className="muted">
            <span className="mono">{hf.account.email}</span>
            {` · ${hf.account.plan} plan · `}
            <strong>{`${hf.account.credits} credits`}</strong>
          </p>
        ) : null}
        {hf && !hf.cli.installed ? (
          <S.CodeBlock language="bash" code={hf.installCommand}>
            {hf.installCommand}
          </S.CodeBlock>
        ) : null}
        <div className="row">
          {p.actions.map(action)}
          <S.Button size="sm" variant="quiet" onClick={() => void store.loadCustomize()}>
            Check again
          </S.Button>
        </div>
        {login?.url ? (
          <p className="muted">
            Finish the login here:{' '}
            <a href={login.url} target="_blank" rel="noopener noreferrer">
              {login.url}
            </a>
          </p>
        ) : null}
        {p.brings.connectors.length + p.brings.skills.length > 0 ? (
          <div className="row">
            <span className="muted">Brings</span>
            {p.brings.connectors.map((id) =>
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
            {p.brings.skills.map((id) =>
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
          </div>
        ) : null}
        {p.id === 'higgsfield' ? (
          <p className="muted">
            Ask Shibaox for an image, a video or a voice: it generates it with your Higgsfield
            credits and saves the file in the conversation. Create an account is an affiliate link:
            Shibaox's maintainer earns a share, you pay the same.
          </p>
        ) : null}
      </div>
    </S.Card>
  );
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
    .filter((p) => (discover ? p.status === 'off' : p.status !== 'off'))
    .filter((p) => matches(query, [p.id, p.name, p.description, ...p.keys.map((k) => k.name)]));
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
