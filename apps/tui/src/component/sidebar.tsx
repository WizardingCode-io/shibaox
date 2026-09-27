import { TextAttributes } from '@opentui/core';
import type { InboxItem } from '@shibaox/daemon';
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import { useConfig } from '../context/config.js';
import { useData } from '../context/data.js';
import { useKeys } from '../context/keys.js';
import { duration, money, shortId } from '../model/format.js';
import { tilde } from '../routes/home.js';
import { pendingFor } from '../routes/session/approval-bar.js';
import { requestText } from '../routes/session/request.js';
import { useTheme } from '../theme/context.js';
import { useDialog } from '../ui/dialog.js';
import { marqueeText } from '../ui/marquee.js';
import { useToast } from '../ui/toast.js';
import { Confirm } from './dialogs/confirm.js';

function Title(props: { text: string }): JSX.Element {
  const theme = useTheme();
  return (
    <box height={1} flexShrink={0} marginTop={1}>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
        {props.text}
      </text>
    </box>
  );
}

const NODE_MARK: Record<string, string> = {
  completed: '✓',
  passed: '✓',
  running: '·',
  waiting: '▲',
  failed: '✗',
  gate_failed: '✗',
};

/** The current run at a glance: request, context, nodes as a checklist, files, and what needs you. */
export function Sidebar(props: {
  /** The latest run of the tab (its nodes and pending items). */
  runId: string;
  /** The first run of the tab (its request titles the sidebar). */
  rootId?: string;
  width: number;
  focused: boolean;
  onFocusBack: () => void;
}): JSX.Element {
  const data = useData();
  const config = useConfig();
  const theme = useTheme().surface('sidebar');
  const dialog = useDialog();
  const toast = useToast();
  const state = () => data.state.states[props.runId];
  const root = () => data.state.states[props.rootId ?? props.runId];
  const summary = () => data.state.runs.find((r) => r.runId === props.runId);
  const spent = () =>
    data
      .threadOf(props.rootId ?? props.runId)
      .reduce((n, id) => n + (data.state.states[id]?.spentUsd ?? 0), 0);
  const cards = data.timeline(props.runId);
  const inner = () => Math.max(8, props.width - 2);

  const nodes = createMemo(() => {
    const wf = state()?.workflowSnapshot;
    const st = state()?.nodes ?? {};
    const ids = wf ? Object.keys(wf.nodes) : Object.keys(st);
    return ids.map((id) => ({ id, status: st[id]?.status ?? 'pending' }));
  });
  const done = () =>
    nodes().filter((n) => n.status === 'completed' || n.status === 'passed').length;
  const files = createMemo(() => {
    const out = new Set<string>();
    for (const c of cards()) {
      if (c.kind === 'node') for (const b of c.blocks) if (b.kind === 'file') out.add(b.path);
      if (c.kind === 'summary') for (const f of c.files) out.add(f);
    }
    return [...out];
  });
  const elapsed = () => {
    const created = summary()?.createdAt;
    if (!created) return undefined;
    const from = Date.parse(created);
    const terminal = ['completed', 'failed', 'cancelled'].includes(summary()?.status ?? '');
    const to = terminal ? Date.parse(summary()?.updatedAt ?? created) : Date.now();
    return Number.isFinite(from) && Number.isFinite(to)
      ? duration(Math.max(0, to - from))
      : undefined;
  };
  const items = createMemo(() => pendingFor(data.state.inbox, props.runId));
  const [cursor, setCursor] = createSignal(0);
  const selectedItem = () => items()[Math.min(cursor(), Math.max(0, items().length - 1))];

  /** Answers like the approval bar: a command approval asks y first. */
  const answer = (item: InboxItem, approved: boolean) => {
    if (approved && item.kind === 'approval') {
      dialog.open(() => (
        <Confirm
          message={`Approve ${item.prompt}?`}
          onYes={() => {
            dialog.close();
            void data.actions.answer(item.id, true);
          }}
          onNo={() => dialog.close()}
        />
      ));
      return;
    }
    void data.actions.answer(item.id, approved);
  };

  useKeys('pane', (key) => {
    if (!props.focused || key.ctrl || key.meta) return false;
    switch (key.name) {
      case 'j':
      case 'down':
        if (cursor() < items().length - 1) setCursor((c) => c + 1);
        return true;
      case 'k':
      case 'up':
        if (cursor() > 0) setCursor((c) => c - 1);
        return true;
      case 'a':
      case 'd': {
        const item = selectedItem();
        if (item) answer(item, key.name === 'a');
        else toast.show({ message: 'Nothing waiting', variant: 'info' });
        return true;
      }
      default:
        return false;
    }
  });

  return (
    <box
      width={props.width}
      flexShrink={0}
      height="100%"
      flexDirection="column"
      backgroundColor={theme.background.base}
      paddingLeft={2}
      paddingRight={1}
      paddingTop={1}
    >
      <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="word">
        {marqueeText(requestText(root()?.input) || (summary()?.workflow ?? ''), inner() * 3, 0)}
      </text>
      <Title text="Context" />
      <text
        fg={theme.text.muted}
        wrapMode="none"
      >{`${money(spent() || (summary()?.spentUsd ?? 0))} spent`}</text>
      <text
        fg={theme.text.muted}
        wrapMode="none"
      >{`${done()} of ${nodes().length} nodes done`}</text>
      <Show when={elapsed()}>
        <text fg={theme.text.muted} wrapMode="none">
          {elapsed() ?? ''}
        </text>
      </Show>
      <Title text="Nodes" />
      <For each={nodes()}>
        {(n) => (
          <box height={1} flexShrink={0}>
            <text
              fg={
                n.status === 'running'
                  ? theme.text.action.primary.selected
                  : n.status === 'failed' || n.status === 'gate_failed'
                    ? theme.text.feedback.error
                    : n.status === 'pending'
                      ? theme.text.muted
                      : theme.text.base
              }
              wrapMode="none"
            >
              {`[${NODE_MARK[n.status] ?? ' '}] ${n.id}`}
            </text>
          </box>
        )}
      </For>
      <Show when={files().length > 0}>
        <Title text="Files" />
        <For each={files()}>
          {(f) => (
            <box height={1} flexShrink={0}>
              <text fg={theme.text.base} wrapMode="none">
                {marqueeText(`± ${f}`, inner(), 0)}
              </text>
            </box>
          )}
        </For>
      </Show>
      <Show when={items().length > 0}>
        <Title text={`Needs you (${items().length})`} />
        <For each={items()}>
          {(i) => (
            <box
              height={1}
              flexShrink={0}
              backgroundColor={
                props.focused && selectedItem()?.id === i.id
                  ? theme.background.action.primary.selected
                  : undefined
              }
            >
              <text fg={theme.text.feedback.warning} wrapMode="none">
                {marqueeText(`▲ ${i.prompt}`, inner(), 0)}
              </text>
            </box>
          )}
        </For>
      </Show>
      <box flexGrow={1} />
      <Show when={props.focused}>
        <box height={1} flexShrink={0}>
          <text fg={theme.text.muted} wrapMode="none">
            {items().length > 0 ? 'j/k select · a/d answer · tab back' : 'tab back'}
          </text>
        </box>
      </Show>
      <box height={1} flexShrink={0}>
        <text fg={theme.text.muted} wrapMode="none">
          {marqueeText(tilde(state()?.project ?? state()?.workspace ?? config.cwd), inner(), 0)}
        </text>
      </box>
      <box height={1} flexShrink={0} marginBottom={1}>
        <text fg={theme.text.muted} wrapMode="none">
          <span style={{ fg: theme.text.feedback.success }}>● </span>
          {`shibaox ${config.version} · ${shortId(props.runId)}`}
        </text>
      </box>
    </box>
  );
}
