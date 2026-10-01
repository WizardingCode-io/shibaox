import type { ConnectorTemplate, McpTestResult } from '@wizardingcode/shibaox-daemon';
import { useState } from 'react';
import { ds } from '../../ds.js';
import { useAppState, useStore } from '../../store/hooks.js';
import { ConfirmDialog } from './dialogs/ConfirmDialog.js';
import {
  CustomConnectorDialog,
  type CustomForm,
  formOf,
  TemplateDialog,
} from './dialogs/ConnectorDialog.js';
import { RolesDialog } from './dialogs/RolesDialog.js';
import { inCategory, matches } from './filter.js';
import {
  AddMenu,
  AddOrAdded,
  CardMenu,
  CategoryMenu,
  Empty,
  goTo,
  KeyBadge,
  Toolbar,
} from './parts.js';
import { CONNECTOR_CATEGORIES, type CustomizeView, type McpRow } from './types.js';

type Dialog =
  | { kind: 'template'; template: ConnectorTemplate }
  | { kind: 'custom'; initial?: CustomForm; editing?: boolean }
  | { kind: 'roles'; id: string }
  | { kind: 'remove'; id: string };

/** One server of yours: where it is, who uses it, its keys, Test inline, and its menu. */
function ServerCard(props: {
  row: McpRow;
  result?: McpTestResult;
  onTested: (r: McpTestResult | undefined) => void;
  onMenu: (id: string) => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const r = props.row;
  const [testing, setTesting] = useState(false);
  const result = props.result;
  return (
    <S.Card
      icon="plug"
      title={r.id}
      description={r.description}
      meta={
        <>
          <span className="mono ellipsis" title={r.target}>
            {`${r.transport} · ${r.target}`}
          </span>
          <span>{r.roles.length ? `Roles: ${r.roles.join(', ')}` : 'No role uses it'}</span>
          {r.keys.map((k) => (
            <KeyBadge key={k.name} name={k.name} present={k.present} />
          ))}
        </>
      }
      aside={
        <>
          <S.Button
            size="sm"
            variant="secondary"
            loading={testing}
            onClick={() => {
              setTesting(true);
              void store.testMcp(r.id).then((x) => {
                setTesting(false);
                props.onTested(x);
              });
            }}
          >
            Test
          </S.Button>
          <CardMenu
            name={r.id}
            items={[
              { id: 'roles', label: 'Roles…', icon: 'wrench' },
              { id: 'edit', label: 'Edit…', icon: 'settings' },
              { id: '-', label: '' },
              { id: 'remove', label: 'Remove', icon: 'trash', tone: 'danger' },
            ]}
            onSelect={props.onMenu}
          />
        </>
      }
    >
      {result ? (
        result.ok ? (
          <span className="muted">
            {`${result.tools?.length ?? 0} ${(result.tools?.length ?? 0) === 1 ? 'tool' : 'tools'}: ${(result.tools ?? []).map((t) => t.name).join(', ')}`}
          </span>
        ) : (
          <S.Badge tone="danger">{result.error ?? 'failed'}</S.Badge>
        )
      ) : null}
    </S.Card>
  );
}

/** Connectors: the catalog's MCP servers, and the registry to add from. */
export function ConnectorsTab(props: { view: CustomizeView }): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const c = state.customize;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [results, setResults] = useState<Record<string, McpTestResult | undefined>>({});
  const mcp = c?.mcp ?? [];
  const registry = c?.registry.connectors ?? [];
  const roles = c?.roles ?? [];
  const template = (id: string) => registry.find((t) => t.id === id);
  const discover = props.view === 'discover';
  const attention =
    mcp.some((r) => r.keys.some((k) => !k.present)) ||
    Object.values(results).some((r) => r && !r.ok);

  const shownYours = inCategory(
    mcp.filter((r) =>
      matches(query, [r.id, r.description, r.target, ...r.keys.map((k) => k.name), ...r.roles]),
    ),
    category,
    (r) => [template(r.id)?.category ?? 'Custom'],
  );
  const shownRegistry = inCategory(
    registry.filter((t) =>
      matches(query, [t.id, t.name, t.description, t.vendor, ...t.keys.map((k) => k.name)]),
    ),
    category,
    (t) => [t.category],
  );
  const categories = discover ? [...CONNECTOR_CATEGORIES] : [...CONNECTOR_CATEGORIES, 'Custom'];

  return (
    <>
      <Toolbar
        view={{ value: props.view, dot: attention, onChange: (v) => goTo('connectors', v) }}
        search={{ label: 'Search connectors', value: query, onChange: setQuery }}
        category={<CategoryMenu categories={categories} value={category} onChange={setCategory} />}
        add={
          <AddMenu
            items={[
              {
                id: 'custom',
                label: 'Custom connector',
                hint: 'any MCP server by URL or command',
                icon: 'server',
              },
              {
                id: 'registry',
                label: 'From the registry',
                hint: 'GitHub, Notion, Playwright…',
                icon: 'package',
              },
            ]}
            onSelect={(id) =>
              id === 'custom' ? setDialog({ kind: 'custom' }) : goTo('connectors', 'discover')
            }
          />
        }
      />
      {!c ? <p className="muted">Reading the org…</p> : null}
      {c && !discover ? (
        mcp.length === 0 ? (
          <Empty>
            No connectors yet. Add one from Discover, or any MCP server as a custom connector.
          </Empty>
        ) : shownYours.length === 0 ? (
          <Empty>{`Nothing matches “${query.trim()}”.`}</Empty>
        ) : (
          <div className="grid-2">
            {shownYours.map((r) => (
              <ServerCard
                key={r.id}
                row={r}
                result={results[r.id]}
                onTested={(x) => setResults((m) => ({ ...m, [r.id]: x }))}
                onMenu={(id) => {
                  if (id === 'roles') setDialog({ kind: 'roles', id: r.id });
                  else if (id === 'remove') setDialog({ kind: 'remove', id: r.id });
                  else
                    setDialog({
                      kind: 'custom',
                      initial: formOf(r, roles),
                      editing: true,
                    });
                }}
              />
            ))}
          </div>
        )
      ) : null}
      {c && discover ? (
        shownRegistry.length === 0 ? (
          <Empty>
            {registry.length === 0
              ? 'This daemon has no connector registry.'
              : `Nothing matches “${query.trim()}”.`}
          </Empty>
        ) : (
          <div className="grid-2">
            {shownRegistry.map((t) => (
              <S.Card
                key={t.id}
                icon="plug"
                title={t.name}
                description={t.description}
                meta={
                  <>
                    <span>{`by ${t.vendor}`}</span>
                    {t.verified ? (
                      <S.Badge tone="matcha" icon="check">
                        verified
                      </S.Badge>
                    ) : null}
                    <S.Badge>{t.category}</S.Badge>
                    {t.keys.map((k) => (
                      <span key={k.name} className="mono">
                        {k.name}
                      </span>
                    ))}
                    {t.note ? <span>{t.note}</span> : null}
                  </>
                }
                aside={
                  <AddOrAdded
                    name={t.name}
                    added={mcp.some((r) => r.id === t.id)}
                    onAdd={() => setDialog({ kind: 'template', template: t })}
                  />
                }
              />
            ))}
          </div>
        )
      ) : null}

      {dialog?.kind === 'template' ? (
        <TemplateDialog
          template={dialog.template}
          roles={roles}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'custom' ? (
        <CustomConnectorDialog
          roles={roles}
          initial={dialog.initial}
          editing={dialog.editing}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'roles' ? (
        <RolesDialog
          kind="mcp"
          id={dialog.id}
          name={dialog.id}
          roles={roles}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <ConfirmDialog
          title={`Remove ${dialog.id}?`}
          description={`It is taken out of every role first, then catalog/${dialog.id}.yaml is deleted.`}
          confirm="Remove"
          onConfirm={() => void store.removeMcp(dialog.id)}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </>
  );
}
