import { homePaths } from '@shibaox/daemon';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { Help } from '../components/Help.js';
import { InboxBanner } from '../components/InboxBanner.js';
import { InboxList } from '../components/InboxList.js';
import { NewRunForm } from '../components/NewRunForm.js';
import { Prompt, type PromptProps } from '../components/Prompt.js';
import { RunDetail } from '../components/RunDetail.js';
import { RunList } from '../components/RunList.js';
import { TitleBar } from '../components/TitleBar.js';
import { Toast } from '../components/Toast.js';
import { type TerminalSize, useStore, useTerminalSize } from '../hooks.js';
import { KEY_HELP, LIST_WIDTH, MIN_COLUMNS, MIN_ROWS, NARROW_COLUMNS } from '../keys.js';
import type { Poller } from '../poll.js';
import type { AppStore } from '../store.js';
import { colors, motionEnabled } from '../theme.js';

export interface DashboardProps {
  store: AppStore;
  poller: Poller;
  version: string;
  env?: NodeJS.ProcessEnv;
  /** Terminal size override (tests); defaults to the real terminal. */
  size?: TerminalSize;
  /** Working directory for the new-run form defaults. */
  cwd?: string;
  /** The shibaox home (`ui.json`); defaults to `homePaths(env).root`. */
  home?: string;
  onExit: (code: number) => void;
}

type PromptState = Omit<PromptProps, 'onCancel'>;

const WAVE_MS = 120;

export function Dashboard(props: DashboardProps) {
  const { store, poller, version, env = process.env, onExit } = props;
  const state = useStore(store);
  const terminal = useTerminalSize();
  const size = props.size ?? terminal;
  const motion = motionEnabled(env);
  const [frame, setFrame] = useState(0);
  const [offset, setOffset] = useState<number | undefined>(undefined); // undefined = follow the end
  const [prompt, setPrompt] = useState<PromptState | undefined>(undefined);
  const [inboxIndex, setInboxIndex] = useState(0);

  const selected = state.selectedRunId;
  const lines = selected ? (state.streams[selected] ?? []) : [];
  // a new selection starts at the end of its stream (state derived from the previous render)
  const [prevSelected, setPrevSelected] = useState(selected);
  if (prevSelected !== selected) {
    setPrevSelected(selected);
    setOffset(undefined);
  }
  const hasRunningTool = lines.some((l) => l.kind === 'tool' && l.tool?.status === 'running');
  useEffect(() => {
    if (!motion || !hasRunningTool) return;
    const t = setInterval(() => setFrame((f) => f + 1), WAVE_MS);
    return () => clearInterval(t);
  }, [motion, hasRunningTool]);

  const narrow = size.columns < NARROW_COLUMNS;
  const tooSmall = size.columns < MIN_COLUMNS || size.rows < MIN_ROWS;
  const bannerRows = state.inbox.length > 0 ? 1 : 0;
  const bodyHeight = Math.max(3, size.rows - 3 - bannerRows);
  const listWidth = narrow ? size.columns : LIST_WIDTH;
  const detailWidth = narrow ? size.columns : size.columns - LIST_WIDTH - 1;
  const streamHeight = Math.max(
    1,
    bodyHeight -
      2 -
      Object.keys(state.runStates[selected ?? '']?.workflowSnapshot?.nodes ?? {}).length,
  );

  useInput(
    (input, key) => {
      // keys can arrive faster than React re-renders: read the live store, not the render scope
      const s = store.get();
      const selectedNow = s.selectedRunId;
      const linesNow = selectedNow ? (s.streams[selectedNow] ?? []) : [];
      const nodeCount = Object.keys(
        s.runStates[selectedNow ?? '']?.workflowSnapshot?.nodes ??
          s.runStates[selectedNow ?? '']?.nodes ??
          {},
      ).length;
      const streamHeightNow = Math.max(1, bodyHeight - 2 - nodeCount);
      const first = s.inbox[0];
      const needDaemonNow = (): boolean => {
        if (s.actionsEnabled) return true;
        store.showToast('Daemon unreachable', 'danger');
        return false;
      };
      if (prompt) return; // the Prompt handles its own keys
      if (s.view === 'help' || s.view === 'inboxList') {
        if (key.escape || input === 'q') return store.setView('dashboard');
        if (s.view === 'inboxList') {
          if (input === 'j' || key.downArrow)
            return setInboxIndex((i) => Math.min(i + 1, s.inbox.length - 1));
          if (input === 'k' || key.upArrow) return setInboxIndex((i) => Math.max(i - 1, 0));
          const target = s.inbox[inboxIndex];
          if ((input === 'a' || input === 'd') && target && needDaemonNow()) {
            void poller.answer(target.id, input === 'a');
            store.setView('dashboard');
          }
        }
        return;
      }
      if (s.view === 'newRun') return; // the form handles its own keys
      if (input === 'q' || key.escape || (key.ctrl && input === 'c')) return onExit(0);
      if (input === '?') return store.setView('help');
      if (input === 'f') return store.setFilter(s.filter === 'active' ? 'all' : 'active');
      if (key.tab) return store.setFocus(s.focus === 'list' ? 'detail' : 'list');
      if (key.return) return store.setFocus('detail');
      if (input === 'j' || key.downArrow) {
        if (s.focus === 'list') return store.moveSelection(1);
        // reaching the bottom turns auto-scroll back on (offset undefined = follow the end)
        return setOffset((o) => {
          const max = Math.max(0, linesNow.length - streamHeightNow);
          const next = Math.min((o ?? max) + 1, max);
          return next >= max ? undefined : next;
        });
      }
      if (input === 'k' || key.upArrow) {
        if (s.focus === 'list') return store.moveSelection(-1);
        return setOffset((o) =>
          Math.max((o ?? Math.max(0, linesNow.length - streamHeightNow)) - 1, 0),
        );
      }
      if (key.pageDown) return setOffset(undefined);
      if (input === 'a' || input === 'd') {
        if (!first || !needDaemonNow()) return;
        const approved = input === 'a';
        // a push or deploy is irreversible: confirm it; a human decision is one key
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
      if (input === 'n') {
        if (!first || !needDaemonNow()) return;
        return setPrompt({
          label: 'Note:',
          kind: 'text',
          onSubmit: (v) => {
            setPrompt(undefined);
            void poller.answer(first.id, true, String(v) || undefined);
          },
        });
      }
      if (input === 'i') {
        if (s.inbox.length === 0) return;
        setInboxIndex(0);
        return store.setView('inboxList');
      }
      if (input === 'N') {
        if (!needDaemonNow()) return;
        return store.setView('newRun');
      }
      if (input === 'c') {
        if (!selectedNow || !needDaemonNow()) return;
        return setPrompt({
          label: `Cancel run ${selectedNow.slice(0, 8)}?`,
          kind: 'confirm',
          onSubmit: (v) => {
            setPrompt(undefined);
            if (v === true) void poller.cancel(selectedNow);
          },
        });
      }
      if (input === 'r') {
        if (!selectedNow || !needDaemonNow()) return;
        const st =
          s.runStates[selectedNow]?.status ?? s.runs.find((r) => r.runId === selectedNow)?.status;
        if (st === 'paused_budget')
          return setPrompt({
            label: 'New budget in USD:',
            kind: 'text',
            onSubmit: (v) => {
              setPrompt(undefined);
              const n = Number(v);
              if (Number.isFinite(n) && n > 0) void poller.resume(selectedNow, n);
              else store.showToast('Enter a positive number', 'danger');
            },
          });
        void poller.resume(selectedNow);
      }
    },
    { isActive: !tooSmall },
  );

  if (tooSmall)
    return (
      <Text>
        Terminal too small (need {MIN_COLUMNS}×{MIN_ROWS})
      </Text>
    );

  const runSummary = state.runs.find((r) => r.runId === selected);
  const visible = store.visibleRuns();
  const effectiveOffset = offset ?? Math.max(0, lines.length - streamHeight);

  let body: React.ReactNode;
  if (state.view === 'help') body = <Help />;
  else if (state.view === 'inboxList')
    body = <InboxList items={state.inbox} selected={inboxIndex} />;
  else if (state.view === 'newRun')
    body = (
      <NewRunForm
        cwd={props.cwd ?? process.cwd()}
        home={props.home ?? homePaths(env).root}
        env={env}
        onSubmit={async (req) => {
          const id = await poller.submit(req);
          // the poller already toasted the daemon's message; surface it in the form too
          if (!id) throw new Error(store.get().toast?.text ?? 'Could not submit the run');
          return id;
        }}
        onCancel={() => store.setView('dashboard')}
        onDone={() => store.setView('dashboard')}
      />
    );
  else {
    const list = (
      <RunList
        runs={visible}
        selectedRunId={selected}
        focused={state.focus === 'list'}
        height={bodyHeight}
        width={listWidth}
      />
    );
    const detail = (
      <RunDetail
        state={selected ? state.runStates[selected] : undefined}
        summary={runSummary}
        lines={lines}
        height={bodyHeight}
        width={detailWidth}
        offset={effectiveOffset}
        motion={motion}
        frame={frame}
      />
    );
    body = narrow ? (
      state.focus === 'list' ? (
        list
      ) : (
        detail
      )
    ) : (
      <Box flexDirection="row" height={bodyHeight}>
        {list}
        <Text color={colors.muted}>{'│'}</Text>
        {detail}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <TitleBar
        version={version}
        health={state.health}
        reachable={state.daemonReachable}
        width={size.columns}
      />
      {state.inbox.length > 0 && state.view === 'dashboard' ? (
        <InboxBanner items={state.inbox} width={size.columns} />
      ) : null}
      <Box flexGrow={1}>{body}</Box>
      {prompt ? (
        <Prompt {...prompt} onCancel={() => setPrompt(undefined)} />
      ) : state.toast ? (
        <Toast toast={state.toast} />
      ) : (
        <Text color={colors.muted} wrap="truncate">
          {KEY_HELP}
        </Text>
      )}
    </Box>
  );
}
