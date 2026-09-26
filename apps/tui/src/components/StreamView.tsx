import { Box, Text } from 'ink';
import type { StreamLine } from '../stream.js';
import { colors } from '../theme.js';
import { ToolCallLine } from './ToolCallLine.js';

export interface StreamViewProps {
  lines: StreamLine[];
  height: number;
  width: number;
  /** Lines hidden above the window; `lines.length - height` shows the end. */
  offset: number;
  motion: boolean;
  frame: number;
}

/** The last `height` lines from `offset`, one Ink line each. */
export function StreamView({ lines, height, width, offset, motion, frame }: StreamViewProps) {
  const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - height)));
  const shown = lines.slice(start, start + height);
  return (
    <Box flexDirection="column" width={width} height={height}>
      {shown.map((line, i) => {
        const key = `${start + i}`;
        if (line.kind === 'tool' && line.tool)
          return (
            <ToolCallLine
              key={key}
              tool={line.tool}
              depth={line.depth}
              motion={motion}
              frame={frame}
            />
          );
        const pad = line.depth === 1 ? '    ' : '';
        if (line.kind === 'event' || line.kind === 'session')
          return (
            <Text key={key} color={colors.muted}>
              {pad}
              {line.text}
            </Text>
          );
        return (
          <Text key={key} wrap="truncate">
            {pad}
            {line.text}
          </Text>
        );
      })}
    </Box>
  );
}
