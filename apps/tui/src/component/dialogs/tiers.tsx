import { TextAttributes } from '@opentui/core';
import type { ModelChoice, OrgConfig, OrgConfigPatch } from '@wizardingcode/shibaox-daemon';
import fuzzysort from 'fuzzysort';
import { createMemo, createResource, createSignal, For, type JSX, Show } from 'solid-js';
import { useClient } from '../../context/client.js';
import { useKeys } from '../../context/keys.js';
import { useTheme } from '../../theme/context.js';
import { Dialog, useDialog } from '../../ui/dialog.js';
import { useToast } from '../../ui/toast.js';

const VISIBLE = 12;
type RowName = 'strong' | 'cheap' | 'decision' | 'judge' | 'adapter' | 'routing';
interface Row {
  name: RowName;
  value?: string;
  note: string;
}
const ADAPTERS = ['direct', 'claude-code', 'mock'];
const ROUTING = ['on', 'off', 'default'];

/** Jev routing of chat turns as models.yaml has it: on, off, or the default. */
const routingWord = (c: OrgConfig | undefined): string =>
  c?.routing?.jev === true ? 'on' : c?.routing?.jev === false ? 'off' : 'default';

/** The patch a routing choice saves (`default`: back to on-with-Jev). */
export function routingPatch(value: string): OrgConfigPatch {
  return { routing: { jev: value === 'on' ? true : value === 'off' ? false : null } };
}

/** What the dialog lists for an org config, in the order people read it. */
export function tierRows(c: OrgConfig | undefined): Row[] {
  return [
    { name: 'strong', value: c?.tiers.strong, note: 'tasks that need the best model' },
    { name: 'cheap', value: c?.tiers.cheap, note: 'the orchestrator and light roles' },
    { name: 'decision', value: c?.tiers.decision, note: 'decide nodes (model ref or jev-latest)' },
    { name: 'judge', value: c?.judge, note: 'judge checks (default: decision, then strong)' },
    { name: 'adapter', value: c?.adapter, note: 'default runtime; a chosen model overrides it' },
    {
      name: 'routing',
      value: routingWord(c),
      note: 'Jev routes chat turns (default: on with TYPESAFE_API_KEY when Jev decides)',
    },
  ];
}

/** The choices for a row: the daemon's models (usable first) for a tier, the adapters otherwise. */
export function tierChoices(name: RowName, models: readonly ModelChoice[]): string[] {
  if (name === 'adapter') return ADAPTERS;
  if (name === 'routing') return ROUTING;
  const refs = [...models]
    .sort((a, b) => Number(b.configured) - Number(a.configured))
    .map((m) => m.ref);
  return name === 'decision' ? ['jev-latest', ...refs] : refs;
}

/**
 * The org's tiers, judge and adapter: ↑/↓ pick a row, enter opens the list of models (typed
 * text filters it), enter again saves through the daemon; `x` clears judge/adapter.
 */
export function TiersDialog(props: { orgRoot: string; onSaved?: () => void }): JSX.Element {
  const client = useClient();
  const dialog = useDialog();
  const toast = useToast();
  const theme = useTheme().surface('dialog');
  const [config, { refetch }] = createResource(() => client.orgConfig(props.orgRoot));
  const [models] = createResource(() => client.models().catch(() => []));
  const rows = createMemo(() => tierRows(config()));
  const [cursor, setCursor] = createSignal(0);
  const [editing, setEditing] = createSignal<RowName | undefined>();
  const [query, setQuery] = createSignal('');
  const [pick, setPick] = createSignal(0);
  const choices = createMemo(() => {
    const name = editing();
    if (!name) return [];
    const all = tierChoices(name, models() ?? []);
    const q = query().trim();
    if (!q) return all;
    return fuzzysort.go(q, all).map((r) => r.target);
  });
  const selected = () => rows()[Math.min(cursor(), rows().length - 1)];
  const patchFor = (name: RowName, value: string | null): OrgConfigPatch =>
    name === 'routing'
      ? routingPatch(value ?? 'default')
      : name === 'judge'
        ? { judge: value }
        : name === 'adapter'
          ? { adapter: value as OrgConfigPatch['adapter'] }
          : { tiers: { [name]: value } };
  const save = async (name: RowName, value: string | null) => {
    try {
      await client.setOrgConfig(props.orgRoot, patchFor(name, value));
      toast.show({ message: value ? `${name} → ${value}` : `${name} cleared`, variant: 'success' });
      await refetch();
      props.onSaved?.();
    } catch (e) {
      toast.show({
        message: `Could not set ${name}: ${e instanceof Error ? e.message : String(e)}`,
        variant: 'error',
      });
    }
  };
  const choose = () => {
    const name = editing();
    const value = choices()[Math.min(pick(), choices().length - 1)];
    setEditing(undefined);
    setQuery('');
    if (name && value) void save(name, value);
  };
  useKeys('dialog', (key) => {
    if (editing()) {
      // the input has the text; the list keys are ours
      if (key.name === 'up') {
        setPick((c) => Math.max(0, c - 1));
        return true;
      }
      if (key.name === 'down') {
        setPick((c) => Math.min(choices().length - 1, c + 1));
        return true;
      }
      return false;
    }
    if (key.name === 'up') {
      setCursor((c) => Math.max(0, c - 1));
      return true;
    }
    if (key.name === 'down') {
      setCursor((c) => Math.min(rows().length - 1, c + 1));
      return true;
    }
    if (key.name === 'return') {
      const r = selected();
      // the input mounts on the next tick: a focused input would receive this same enter
      if (r)
        setTimeout(() => {
          setQuery('');
          setPick(0);
          setEditing(r.name);
        }, 0);
      return true;
    }
    if (key.name === 'x' && !key.ctrl) {
      const r = selected();
      if (r && (r.name === 'judge' || r.name === 'adapter')) void save(r.name, null);
      else if (r?.name === 'routing') void save(r.name, 'default');
      else toast.show({ message: 'Tiers cannot be cleared, pick another model', variant: 'info' });
      return true;
    }
    return false;
  });
  const start = () =>
    Math.max(0, Math.min(pick() - Math.floor(VISIBLE / 2), choices().length - VISIBLE));
  const title = () => `Tiers · ${config()?.organization ?? ''}`;
  // the Dialog sees escape first (its handler is the newest): back out of the list, else close
  const back = () => {
    if (!editing()) return dialog.close();
    setEditing(undefined);
    setQuery('');
  };
  return (
    <Dialog size="large" title={title()} onClose={back}>
      <box flexDirection="column" width="100%">
        <Show when={config.error}>
          <text fg={theme.text.feedback.error}>
            {`Could not read the org: ${String((config.error as Error)?.message ?? config.error)}`}
          </text>
        </Show>
        <For each={rows()}>
          {(r, i) => {
            const active = () => i() === Math.min(cursor(), rows().length - 1);
            return (
              <box
                height={1}
                flexShrink={0}
                flexDirection="row"
                backgroundColor={active() ? theme.background.action.primary.selected : undefined}
              >
                <text
                  fg={active() ? theme.text.action.primary.selected : theme.text.base}
                  attributes={TextAttributes.BOLD}
                  wrapMode="none"
                  flexShrink={0}
                >
                  {` ${r.name.padEnd(10)}`}
                </text>
                <text
                  fg={r.value ? theme.text.base : theme.text.muted}
                  wrapMode="none"
                  flexShrink={0}
                >
                  {(r.value ?? '—').padEnd(44)}
                </text>
                <text fg={theme.text.muted} wrapMode="none" flexShrink={1}>
                  {r.note}
                </text>
              </box>
            );
          }}
        </For>
        <Show
          when={editing()}
          fallback={
            <box height={1} flexShrink={0} marginTop={1}>
              <text fg={theme.text.muted} wrapMode="none">
                {`${config()?.per_run_usd !== undefined ? `budget $${config()?.per_run_usd} per run (/budget for this run) · ` : ''}↑/↓ choose · enter change · x clear judge/adapter · esc close`}
              </text>
            </box>
          }
        >
          <box height={1} flexShrink={0} marginTop={1} flexDirection="row">
            <text fg={theme.text.base} wrapMode="none" flexShrink={0}>
              {`${editing() ?? ''} › `}
            </text>
            <input
              focused
              placeholder="type to filter"
              onInput={(v: string) => {
                setQuery(v);
                setPick(0);
              }}
              onSubmit={choose}
              flexGrow={1}
              backgroundColor={theme.background.base}
              focusedBackgroundColor={theme.background.base}
              textColor={theme.text.base}
              placeholderColor={theme.text.muted}
              cursorColor={theme.text.action.primary.selected}
            />
          </box>
          <For each={choices().slice(start(), start() + VISIBLE)}>
            {(c, i) => {
              const active = () => start() + i() === Math.min(pick(), choices().length - 1);
              return (
                <box
                  height={1}
                  flexShrink={0}
                  backgroundColor={active() ? theme.background.action.primary.selected : undefined}
                >
                  <text
                    fg={active() ? theme.text.action.primary.selected : theme.text.base}
                    wrapMode="none"
                  >
                    {`   ${c}`}
                  </text>
                </box>
              );
            }}
          </For>
          <box height={1} flexShrink={0}>
            <text fg={theme.text.muted} wrapMode="none">
              {choices().length === 0
                ? 'No model matches'
                : `${choices().length} choices · ↑/↓ pick · enter save · esc back`}
            </text>
          </box>
        </Show>
      </box>
    </Dialog>
  );
}
