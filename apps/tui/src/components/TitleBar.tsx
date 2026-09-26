import type { Health } from '@shibaox/daemon';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

export interface TitleBarProps {
  version?: string;
  health?: Health;
  reachable: boolean;
  width: number;
}

export function TitleBar({ version, health, reachable, width }: TitleBarProps) {
  const text = reachable
    ? `shibaox · daemon ${health?.version ?? version ?? '?'} · ${health?.runs.running ?? 0} running · ${health?.runs.queued ?? 0} queued`
    : 'shibaox · Daemon unreachable, retrying…';
  return (
    <Box width={width}>
      <Text bold color={reachable ? colors.focus : colors.danger} wrap="truncate">
        {text}
      </Text>
    </Box>
  );
}
