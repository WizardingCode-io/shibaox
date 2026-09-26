import type { RunState } from '@shibaox/core';
import type { RunSummaryPlus } from '@shibaox/daemon';
import { Box, Text } from 'ink';
import type { StreamLine } from '../stream.js';
import { colors, statusOf } from '../theme.js';
import { StreamView } from './StreamView.js';

export interface RunDetailProps {
  state?: RunState;
  summary?: RunSummaryPlus;
  lines: StreamLine[];
  height: number;
  width: number;
  offset: number;
  motion: boolean;
  frame: number;
}

const nodeColor = (status: string): string | undefined => {
  switch (status) {
    case 'running':
      return colors.running;
    case 'completed':
    case 'passed':
      return colors.success;
    case 'failed':
      return colors.danger;
    case 'gate_failed':
    case 'waiting':
      return colors.attention;
    default:
      return colors.muted;
  }
};

/** Header, one line per workflow node, then the run's stream. */
export function RunDetail({
  state,
  summary,
  lines,
  height,
  width,
  offset,
  motion,
  frame,
}: RunDetailProps) {
  const status = state?.status ?? summary?.status;
  if (!status)
    return (
      <Box width={width} height={height}>
        <Text color={colors.muted}>Select a run</Text>
      </Box>
    );
  const runId = state?.runId ?? summary?.runId ?? '';
  const look = statusOf({ status });
  const spent = state?.spentUsd ?? summary?.spentUsd ?? 0;
  const header = [
    `${runId.slice(0, 8)} ${state?.workflow ?? summary?.workflow ?? ''}`,
    look.word,
    `$${spent.toFixed(4)}`,
    ...(state?.branch ? [state.branch] : []),
  ].join(' · ');
  const nodeIds = Object.keys(state?.workflowSnapshot?.nodes ?? state?.nodes ?? {});
  const nodeLines = nodeIds.map((id) => {
    const n = state?.nodes[id];
    const st = n?.status ?? 'pending';
    const extra = n?.choice ? ` choice=${n.choice}` : n?.error ? ` error=${n.error}` : '';
    return {
      id,
      text: `${id.padEnd(14)} ${st.padEnd(11)} attempts=${n?.attempts ?? 0}${extra}`,
      color: nodeColor(st),
    };
  });
  const streamHeight = Math.max(1, height - 2 - nodeLines.length);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text bold color={look.color} wrap="truncate">
        {header}
      </Text>
      {nodeLines.map((n) => (
        <Text key={n.id} color={n.color} wrap="truncate">
          {n.text}
        </Text>
      ))}
      <Text color={colors.muted}>{'─'.repeat(Math.max(1, Math.min(width, 80)))}</Text>
      <StreamView
        lines={lines}
        height={streamHeight}
        width={width}
        offset={offset}
        motion={motion}
        frame={frame}
      />
    </Box>
  );
}
