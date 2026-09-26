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

  const needDaemon = (): boolean => {
    if (state.actionsEnabled) return true;
    store.showToast('Daemon unreachable', 'danger');
    return false;
  };
  const firstInbox = state.inbox[0];

  useInput(
    (input, key) => {
      if (prompt) return; // the Prompt handles its own keys
      if (state.view === 'help' || state.view === 'inboxList') {
        if (key.escape || input === 'q') return store.setView('dashboard');
        if (state.view === 'inboxList') {
          if (input === 'j' || key.downArrow)
            return setInboxIndex((i) => Math.min(i + 1, state.inbox.length - 1));
          if (input === 'k' || key.upArrow) return setInboxIndex((i) => Math.max(i - 1, 0));
          const target = state.inbox[inboxIndex];
          if ((input === 'a' || input === 'd') && target && needDaemon()) {
            void poller.answer(target.id, input === 'a');
            store.setView('dashboard');
          }
        }
        return;
      }
      if (state.view === 'newRun') return; // the form handles its own keys
      if (input === 'q' || key.escape) return onExit(0);
      if (input === '?') return store.setView('help');
      if (input === 'f') return store.setFilter(state.filter === 'active' ? 'all' : 'active');
      if (key.tab) return store.setFocus(state.focus === 'list' ? 'detail' : 'list');
      if (key.return) return store.setFocus('detail');
      if (input === 'j' || key.downArrow) {
        if (state.focus === 'list') return store.moveSelection(1);
        return setOffset((o) =>
          Math.min(
            (o ?? Math.max(0, lines.length - streamHeight)) + 1,
            Math.max(0, lines.length - streamHeight),
          ),
        );
      }
      if (input === 'k' || key.upArrow) {
        if (state.focus === 'list') return store.moveSelection(-1);
        return setOffset((o) => Math.max((o ?? Math.max(0, lines.length - streamHeight)) - 1, 0));
      }
      if (key.pageDown) return setOffset(undefined);
      if (input === 'a' || input === 'd') {
        if (!firstInbox || !needDaemon()) return;
        void poller.answer(firstInbox.id, input === 'a');
        return;
      }
      if (input === 'n') {
        if (!firstInbox || !needDaemon()) return;
        return setPrompt({
          label: 'Note:',
          kind: 'text',
          onSubmit: (v) => {
            setPrompt(undefined);
            void poller.answer(firstInbox.id, true, String(v) || undefined);
          },
        });
      }
      if (input === 'i') {
        if (state.inbox.length === 0) return;
        setInboxIndex(0);
        return store.setView('inboxList');
      }
      if (input === 'N') {
        if (!needDaemon()) return;
        return store.setView('newRun');
      }
      if (input === 'c') {
        if (!selected || !needDaemon()) return;
        return setPrompt({
          label: `Cancel run ${selected.slice(0, 8)}?`,
          kind: 'confirm',
          onSubmit: (v) => {
            setPrompt(undefined);
            if (v === true) void poller.cancel(selected);
          },
        });
      }
      if (input === 'r') {
        if (!selected || !needDaemon()) return;
        const st =
          state.runStates[selected]?.status ?? state.runs.find((r) => r.runId === selected)?.status;
        if (st === 'paused_budget')
          return setPrompt({
            label: 'New budget in USD:',
            kind: 'text',
            onSubmit: (v) => {
              setPrompt(undefined);
              const n = Number(v);
              if (Number.isFinite(n) && n > 0) void poller.resume(selected, n);
              else store.showToast('Enter a positive number', 'danger');
            },
          });
        void poller.resume(selected);
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
