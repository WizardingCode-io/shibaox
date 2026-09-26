import { Box, Text } from 'ink';
import type { ToolInfo } from '../stream.js';
import { colors, WAVE_FRAMES } from '../theme.js';

export interface ToolCallLineProps {
  tool: ToolInfo;
  depth: 0 | 1;
  motion: boolean;
  frame: number;
}

const statusLook = (
  tool: ToolInfo,
  motion: boolean,
  frame: number,
): { text: string; color: string } => {
  switch (tool.status) {
    case 'done':
      return { text: 'done', color: colors.success };
    case 'error':
      return { text: 'error', color: colors.danger };
    case 'approval':
      return { text: 'needs approval', color: colors.attention };
    default:
      return {
        text: motion ? (WAVE_FRAMES[frame % WAVE_FRAMES.length] as string) : '…',
        color: colors.running,
      };
  }
};

/** `> name summary  40 ms  done`, mapped from the design system's ToolCall (status is a word). */
export function ToolCallLine({ tool, depth, motion, frame }: ToolCallLineProps) {
  const look = statusLook(tool, motion, frame);
  const pad = depth === 1 ? '    ' : '';
  const duration = tool.durationMs === undefined ? '' : `  ${tool.durationMs} ms`;
  // the summary shrinks and truncates; duration and status always stay visible
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text>
          {pad}
          <Text color={colors.muted}>{'> '}</Text>
          <Text bold>{tool.name}</Text>
        </Text>
      </Box>
      {tool.summary ? (
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="truncate"> {tool.summary}</Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Text>
          {duration}
          {'  '}
          <Text color={look.color}>{look.text}</Text>
        </Text>
      </Box>
    </Box>
  );
}
