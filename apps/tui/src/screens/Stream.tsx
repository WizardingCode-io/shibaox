import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { InboxBanner } from '../components/InboxBanner.js';
import { RunDetail } from '../components/RunDetail.js';
import { Toast } from '../components/Toast.js';
import { type TerminalSize, useStore, useTerminalSize } from '../hooks.js';
import type { Poller } from '../poll.js';
import type { AppStore } from '../store.js';
import { colors, motionEnabled } from '../theme.js';

export interface StreamProps {
  store: AppStore;
  poller: Poller;
  runId: string;
  env?: NodeJS.ProcessEnv;
  size?: TerminalSize;
  /** Called once the run ends (with its final status) or the user quits. */
  onEnd: (status: string | undefined) => void;
}

const WAVE_MS = 120;

/** One run, full width: its detail and stream, plus the inbox items of that run (`a`/`d`). */
export function Stream(props: StreamProps) {
  const { store, poller, runId, env = process.env, onEnd } = props;
  const state = useStore(store);
  const terminal = useTerminalSize();
  const size = props.size ?? terminal;
  const motion = motionEnabled(env);
  const [frame, setFrame] = useState(0);
  const lines = state.streams[runId] ?? [];
  const items = state.inbox.filter((i) => i.runId === runId);
  const runState = state.runStates[runId];
  const summary = state.runs.find((r) => r.runId === runId);
  const hasRunningTool = lines.some((l) => l.kind === 'tool' && l.tool?.status === 'running');

  useEffect(() => {
    if (!motion || !hasRunningTool) return;
    const t = setInterval(() => setFrame((f) => f + 1), WAVE_MS);
    return () => clearInterval(t);
  }, [motion, hasRunningTool]);

  const status = runState?.status;
  useEffect(() => {
    if (status === 'completed' || status === 'failed' || status === 'cancelled') onEnd(status);
  }, [status, onEnd]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) return onEnd(undefined);
    const first = items[0];
    if ((input === 'a' || input === 'd') && first) {
      if (!state.actionsEnabled) return store.showToast('Daemon unreachable', 'danger');
      void poller.answer(first.id, input === 'a');
    }
  });

  const bannerRows = items.length > 0 ? 1 : 0;
  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      {items.length > 0 ? <InboxBanner items={items} width={size.columns} /> : null}
      <RunDetail
        state={runState}
        summary={summary}
        lines={lines}
        height={Math.max(3, size.rows - 1 - bannerRows)}
        width={size.columns}
        offset={Math.max(0, lines.length)}
        motion={motion}
        frame={frame}
      />
      {state.toast ? (
        <Toast toast={state.toast} />
      ) : (
        <Text color={colors.muted}>
          {state.daemonReachable
            ? 'a/d answer · q stop following (the run keeps running)'
            : 'Daemon unreachable, retrying…'}
        </Text>
      )}
    </Box>
  );
}
