import type { RunSummaryPlus } from '@shibaox/daemon';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';
import { AgentStatus } from './AgentStatus.js';

export interface RunListProps {
  runs: RunSummaryPlus[];
  selectedRunId?: string;
  focused: boolean;
  height: number;
  width: number;
}

/** One run per two lines: `▸ id8 workflow` then its status; scrolls to keep the selection visible. */
export function RunList({ runs, selectedRunId, focused, height, width }: RunListProps) {
  if (runs.length === 0)
    return (
      <Box width={width} height={height}>
        <Text color={colors.muted}>No runs yet</Text>
      </Box>
    );
  const perRun = 2;
  const visible = Math.max(1, Math.floor(height / perRun));
  const selected = Math.max(
    0,
    runs.findIndex((r) => r.runId === selectedRunId),
  );
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), runs.length - visible));
  const shown = runs.slice(start, start + visible);
  const nameWidth = Math.max(4, width - 12);
  return (
    <Box flexDirection="column" width={width} height={height}>
      {shown.map((r) => {
        const isSelected = r.runId === selectedRunId;
        const marker = isSelected ? '▸' : ' ';
        return (
          <Box key={r.runId} flexDirection="column">
            <Text color={isSelected && focused ? colors.focus : undefined} bold={isSelected}>
              {marker} {r.runId.slice(0, 8)} {r.workflow.slice(0, nameWidth)}
            </Text>
            <Text>
              {'    '}
              <AgentStatus status={r.status} />
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
