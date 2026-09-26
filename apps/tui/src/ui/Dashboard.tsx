import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { HELP_LINES, KEY_HELP, MIN_COLUMNS, MIN_ROWS, NARROW_COLUMNS } from '../keys.js';
import type { Poller } from '../poll.js';
import type { AppStore } from '../store.js';
import { colors, motionEnabled, statusOf } from '../theme.js';
import { NewRunForm } from './NewRunForm.js';
import { Prompt, type PromptSpec } from './Prompt.js';
import { Banner, Footer, Line, Panel, StatusSpan, streamElements } from './widgets.js';

export interface DashboardProps {
  store: AppStore;
  poller: Poller;
  version: string;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  onExit: (code: number) => void;
}

const WAVE_MS = 120;

export function useAppState(store: AppStore) {
  return useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.get(),
  );
}

/** The dashboard: title, inbox banner, runs | detail, footer. Keys read the live store. */
export function Dashboard(props: DashboardProps) {
  const { store, poller, version, env = process.env, onExit } = props;
  const state = useAppState(store);
  const { width, height } = useTerminalDimensions();
  const motion = motionEnabled(env);
  const [frame, setFrame] = useState(0);
  const [prompt, setPrompt] = useState<PromptSpec | undefined>();
  const [inboxIndex, setInboxIndex] = useState(0);

  const selected = state.selectedRunId;
  const lines = selected ? (state.streams[selected] ?? []) : [];
  const hasRunningTool = lines.some((l) => l.kind === 'tool' && l.tool?.status === 'running');
  useEffect(() => {
    if (!motion || !hasRunningTool) return;
    const t = setInterval(() => setFrame((f) => f + 1), WAVE_MS);
    return () => clearInterval(t);
  }, [motion, hasRunningTool]);

  const tooSmall = width < MIN_COLUMNS || height < MIN_ROWS;
  const narrow = width < NARROW_COLUMNS;

  useKeyboard((key) => {
    // Ctrl-C quits from anywhere: views, prompts and the form included
    if (key.ctrl && key.name === 'c') return onExit(0);
    if (tooSmall) {
      if (key.name === 'q' || key.name === 'escape') onExit(0);
      return;
    }
    const s = store.get();
    if (prompt || s.view === 'newRun') return; // those own the keyboard
    const first = s.inbox[0];
    const needDaemon = (): boolean => {
      if (s.actionsEnabled) return true;
      store.showToast('Daemon unreachable', 'danger');
      return false;
    };
    if (s.view === 'help' || s.view === 'inboxList') {
      if (key.name === 'escape' || key.name === 'q') return store.setView('dashboard');
      if (s.view === 'inboxList') {
        if (key.name === 'j' || key.name === 'down')
          return setInboxIndex((i) => Math.min(i + 1, s.inbox.length - 1));
        if (key.name === 'k' || key.name === 'up') return setInboxIndex((i) => Math.max(i - 1, 0));
        const target = s.inbox[Math.min(inboxIndex, s.inbox.length - 1)];
        if ((key.name === 'a' || key.name === 'd') && target && needDaemon()) {
          void poller.answer(target.id, key.name === 'a');
          store.setView('dashboard');
        }
      }
      return;
    }
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c'))
      return onExit(0);
    if (key.name === '?' || (key.name === '/' && key.shift)) return store.setView('help');
    if (key.name === 'f') return store.setFilter(s.filter === 'active' ? 'all' : 'active');
    if (key.name === 'tab') return store.setFocus(s.focus === 'list' ? 'detail' : 'list');
    if (key.name === 'return') return store.setFocus('detail');
    if ((key.name === 'j' || key.name === 'down') && s.focus === 'list')
      return store.moveSelection(1);
    if ((key.name === 'k' || key.name === 'up') && s.focus === 'list')
      return store.moveSelection(-1);
    if (key.name === 'a' || key.name === 'd') {
      if (!first || !needDaemon()) return;
      const approved = key.name === 'a';
      if (first.kind === 'approval')
        return setPrompt({
          label: `${approved ? 'Approve' : 'Deny'} ${first.prompt}?`,
          kind: 'confirm',
          onSubmit: (v) => {
            setPrompt(undefined);
            if (v === true) void poller.answer(first.id, approved);
          },
        });
      void poller.answer(first.id, approved);
      return;
    }
    if (key.name === 'n' && !key.shift) {
      if (!first || !needDaemon()) return;
      return setPrompt({
        label: 'Note:',
        kind: 'text',
        onSubmit: (v) => {
          setPrompt(undefined);
          void poller.answer(first.id, true, String(v) || undefined);
        },
      });
    }
    if (key.name === 'i') {
      if (s.inbox.length === 0) return;
      setInboxIndex(0);
      return store.setView('inboxList');
    }
    if (key.name === 'N' || (key.name === 'n' && key.shift)) {
      if (!needDaemon()) return;
      return store.setView('newRun');
    }
    if (key.name === 'c') {
      if (!s.selectedRunId || !needDaemon()) return;
      const runId = s.selectedRunId;
      return setPrompt({
        label: `Cancel run ${runId.slice(0, 8)}?`,
        kind: 'confirm',
        onSubmit: (v) => {
          setPrompt(undefined);
          if (v === true) void poller.cancel(runId);
        },
      });
    }
    if (key.name === 'r') {
      if (!s.selectedRunId || !needDaemon()) return;
      const runId = s.selectedRunId;
      const st = s.runStates[runId]?.status ?? s.runs.find((r) => r.runId === runId)?.status;
      if (st === 'paused_budget')
        return setPrompt({
          label: 'New budget in USD:',
          kind: 'text',
          onSubmit: (v) => {
            setPrompt(undefined);
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) void poller.resume(runId, n);
            else store.showToast('Enter a positive number', 'danger');
          },
        });
      void poller.resume(runId);
    }
  });

  if (tooSmall)
    return (
      <box width="100%" height="100%">
        <text fg={colors.danger}>{`Terminal too small (need ${MIN_COLUMNS}×${MIN_ROWS})`}</text>
      </box>
    );

  const visible = store.visibleRuns();
  const runState = selected ? state.runStates[selected] : undefined;
  const summary = state.runs.find((r) => r.runId === selected);
  const status = runState?.status ?? summary?.status;
  const title = state.daemonReachable
    ? `shibaox · daemon ${state.health?.version ?? version} · ${state.health?.runs.running ?? 0} running · ${state.health?.runs.queued ?? 0} queued`
    : 'shibaox · Daemon unreachable, retrying…';
  // the list takes 30% of the width within [24, 44] columns; the detail gets the rest
  const listCols = narrow ? width : Math.min(44, Math.max(24, Math.floor(width * 0.3)));
  const detailWidth = Math.max(20, narrow ? width - 4 : width - listCols - 4);
  const bannerRows = state.inbox.length > 0 && state.view === 'dashboard' ? 3 : 0;
  const bodyHeight = Math.max(3, height - 3 - bannerRows - 1);
  // the list shows a window of runs (two rows each) around the selection
  const perRun = 2;
  const listRows = Math.max(1, Math.floor((bodyHeight - 2) / perRun));
  const selectedIndex = Math.max(
    0,
    visible.findIndex((r) => r.runId === selected),
  );
  const listStart = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(listRows / 2), visible.length - listRows),
  );
  const listWindow = visible.slice(listStart, listStart + listRows);

  const runsPanel = (
    <Panel
      title={
        visible.length > listRows
          ? `Runs (${listStart + 1}–${Math.min(visible.length, listStart + listRows)} of ${visible.length})`
          : 'Runs'
      }
      focused={state.focus === 'list'}
      width={listCols}
      flexShrink={0}
    >
      {visible.length === 0 ? (
        <Line>
          <text fg={colors.muted}>No runs yet. Press N to start one.</text>
        </Line>
      ) : null}
      {listWindow.map((r) => {
        const sel = r.runId === selected;
        return (
          <box key={r.runId} flexDirection="column" flexShrink={0}>
            <Line>
              <text fg={sel ? colors.focus : undefined}>
                {sel ? '▸ ' : '  '}
                <strong>{r.runId.slice(0, 8)}</strong>
                {` ${r.workflow}`}
              </text>
            </Line>
            <Line>
              <text>
                {'    '}
                <StatusSpan status={r.status} />
              </text>
            </Line>
          </box>
        );
      })}
    </Panel>
  );

  const nodeIds = Object.keys(runState?.workflowSnapshot?.nodes ?? runState?.nodes ?? {});
  const detailTitle = selected
    ? `${selected.slice(0, 8)} ${runState?.workflow ?? summary?.workflow ?? ''} · ${status ? statusOf({ status }).word : ''} · $${(runState?.spentUsd ?? summary?.spentUsd ?? 0).toFixed(4)}`
    : 'Run';
  const detailPanel = (
    <Panel title={detailTitle} focused={state.focus === 'detail'} flexGrow={1}>
      {!selected ? (
        <Line>
          <text fg={colors.muted}>Select a run</text>
        </Line>
      ) : null}
      {status ? (
        <Line>
          <text>
            {' '}
            <StatusSpan status={status} />
            {runState?.branch ? <span fg={colors.muted}>{`  ${runState.branch}`}</span> : ''}
          </text>
        </Line>
      ) : null}
      {nodeIds.map((id) => {
        const n = runState?.nodes[id];
        const st = n?.status ?? 'pending';
        const extra = n?.choice ? ` choice=${n.choice}` : n?.error ? ` error=${n.error}` : '';
        const fg =
          st === 'running'
            ? colors.running
            : st === 'completed' || st === 'passed'
              ? colors.success
              : st === 'failed'
                ? colors.danger
                : st === 'gate_failed' || st === 'waiting'
                  ? colors.attention
                  : colors.muted;
        return (
          <Line key={id}>
            <text
              fg={fg}
            >{`  ${id.padEnd(14)} ${st.padEnd(11)} attempts=${n?.attempts ?? 0}${extra}`}</text>
          </Line>
        );
      })}
      {nodeIds.length > 0 ? (
        <Line>
          <text fg={colors.muted}>{'─'.repeat(Math.max(1, detailWidth))}</text>
        </Line>
      ) : null}
      <scrollbox stickyScroll stickyStart="bottom" flexGrow={1} focused={state.focus === 'detail'}>
        {lines.length === 0 && selected ? (
          <text fg={colors.muted}>
            {state.ended[selected] ? 'No stream kept for this run.' : 'No stream yet.'}
          </text>
        ) : null}
        {streamElements(lines, motion, frame, detailWidth - 2)}
      </scrollbox>
    </Panel>
  );

  let body: React.ReactNode;
  if (state.view === 'help')
    body = (
      <Panel title="Keys" focused flexGrow={1}>
        {HELP_LINES.map((l) => (
          <text key={l}>{l}</text>
        ))}
        <text fg={colors.muted}>esc back</text>
      </Panel>
    );
  else if (state.view === 'inboxList')
    body = (
      <Panel title={`Inbox (${state.inbox.length})`} tone="attention" flexGrow={1}>
        {state.inbox.map((i, idx) => (
          <text key={i.id} fg={idx === inboxIndex ? colors.focus : undefined}>
            {`${idx === inboxIndex ? '▸ ' : '  '}${i.kind === 'approval' ? 'Approval' : 'Decision'} · run ${i.runId.slice(0, 8)} · ${i.nodeId}${i.detail.role ? ` · ${i.detail.role}` : ''}: ${i.prompt}`}
          </text>
        ))}
        <text fg={colors.muted}>j/k select · a approve · d deny · esc back</text>
      </Panel>
    );
  else if (state.view === 'newRun')
    body = (
      <NewRunForm
        cwd={props.cwd}
        home={props.home}
        onSubmit={async (req) => {
          const id = await poller.submit(req);
          if (!id) throw new Error(store.get().toast?.text ?? 'Could not submit the run');
          return id;
        }}
        onCancel={() => store.setView('dashboard')}
        onDone={() => store.setView('dashboard')}
      />
    );
  else
    body = (
      <box flexDirection="row" flexGrow={1}>
        {narrow ? (state.focus === 'list' ? runsPanel : detailPanel) : runsPanel}
        {narrow ? null : detailPanel}
      </box>
    );

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Panel height={3} tone={state.daemonReachable ? 'default' : 'danger'}>
        <Line>
          <text fg={state.daemonReachable ? colors.focus : colors.danger}>
            <strong>{title}</strong>
          </text>
        </Line>
      </Panel>
      {state.inbox.length > 0 && state.view === 'dashboard' ? (
        <Banner items={state.inbox} keys="[a]pprove [d]eny [n]ote [i]nbox" />
      ) : null}
      {body}
      {prompt ? (
        <Prompt spec={prompt} onCancel={() => setPrompt(undefined)} />
      ) : (
        <Footer toast={state.toast} keys={KEY_HELP} />
      )}
    </box>
  );
}
