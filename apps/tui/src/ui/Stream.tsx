import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useEffect, useState } from 'react';
import type { Poller } from '../poll.js';
import type { AppStore } from '../store.js';
import { colors, motionEnabled } from '../theme.js';
import { useAppState } from './Dashboard.js';
import { Prompt, type PromptSpec } from './Prompt.js';
import { Banner, Footer, Line, Panel, StatusSpan, streamElements } from './widgets.js';

export interface StreamProps {
  store: AppStore;
  poller: Poller;
  runId: string;
  env?: NodeJS.ProcessEnv;
  onEnd: (status: string | undefined) => void;
}

const WAVE_MS = 120;

/** One run, full width: nodes, live stream, and that run's inbox items (`a`/`d`). */
export function Stream({ store, poller, runId, env = process.env, onEnd }: StreamProps) {
  const state = useAppState(store);
  const { width } = useTerminalDimensions();
  const motion = motionEnabled(env);
  const [frame, setFrame] = useState(0);
  const [prompt, setPrompt] = useState<PromptSpec | undefined>();
  const lines = state.streams[runId] ?? [];
  const items = state.inbox.filter((i) => i.runId === runId);
  const runState = state.runStates[runId];
  const summary = state.runs.find((r) => r.runId === runId);
  const status = runState?.status ?? summary?.status;
  const hasRunningTool = lines.some((l) => l.kind === 'tool' && l.tool?.status === 'running');

  useEffect(() => {
    if (!motion || !hasRunningTool) return;
    const t = setInterval(() => setFrame((f) => f + 1), WAVE_MS);
    return () => clearInterval(t);
  }, [motion, hasRunningTool]);

  const ended = state.ended[runId];
  useEffect(() => {
    if (ended) onEnd(ended);
  }, [ended, onEnd]);

  useKeyboard((key) => {
    if (prompt) return;
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c'))
      return onEnd(undefined);
    const first = items[0];
    if ((key.name === 'a' || key.name === 'd') && first) {
      if (!state.actionsEnabled) return store.showToast('Daemon unreachable', 'danger');
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
    }
  });

  const nodeIds = Object.keys(runState?.workflowSnapshot?.nodes ?? runState?.nodes ?? {});
  const title = `${runId.slice(0, 8)} ${runState?.workflow ?? summary?.workflow ?? ''} · ${status ?? ''} · $${(runState?.spentUsd ?? summary?.spentUsd ?? 0).toFixed(4)}`;
  return (
    <box flexDirection="column" width="100%" height="100%">
      {items.length > 0 ? <Banner items={items} keys="[a]pprove [d]eny" /> : null}
      <Panel title={title} focused flexGrow={1}>
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
          return (
            <Line key={id}>
              <text
                fg={
                  st === 'running'
                    ? colors.running
                    : st === 'completed' || st === 'passed'
                      ? colors.success
                      : st === 'failed'
                        ? colors.danger
                        : colors.muted
                }
              >
                {`  ${id.padEnd(14)} ${st.padEnd(11)} attempts=${n?.attempts ?? 0}${n?.choice ? ` choice=${n.choice}` : n?.error ? ` error=${n.error}` : ''}`}
              </text>
            </Line>
          );
        })}
        {nodeIds.length > 0 ? (
          <Line>
            <text fg={colors.muted}>{'─'.repeat(Math.max(1, width - 4))}</text>
          </Line>
        ) : null}
        <scrollbox stickyScroll stickyStart="bottom" flexGrow={1} focused>
          {lines.length === 0 ? <text fg={colors.muted}>No stream yet.</text> : null}
          {streamElements(lines, motion, frame, width - 6)}
        </scrollbox>
      </Panel>
      {prompt ? (
        <Prompt spec={prompt} onCancel={() => setPrompt(undefined)} />
      ) : (
        <Footer
          toast={state.toast}
          keys={
            state.daemonReachable
              ? 'a/d answer · q stop following (the run keeps running)'
              : 'Daemon unreachable, retrying…'
          }
        />
      )}
    </box>
  );
}
