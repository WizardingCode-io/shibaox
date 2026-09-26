import { Text } from 'ink';
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
  return (
    <Text>
      {pad}
      <Text color={colors.muted}>{'> '}</Text>
      <Text bold>{tool.name}</Text>
      {tool.summary ? ` ${tool.summary}` : ''}
      {duration}
      {'  '}
      <Text color={look.color}>{look.text}</Text>
    </Text>
  );
}
