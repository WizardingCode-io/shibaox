import type { InboxItem } from '@shibaox/daemon';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

export interface InboxListProps {
  items: InboxItem[];
  selected: number;
}

/** Every pending item, the selected one marked; `a`/`d` answer it. */
export function InboxList({ items, selected }: InboxListProps) {
  return (
    <Box flexDirection="column">
      <Text bold color={colors.attention}>
        Inbox ({items.length})
      </Text>
      {items.map((i, idx) => (
        <Text
          key={i.id}
          color={idx === selected ? colors.focus : undefined}
          bold={idx === selected}
        >
          {idx === selected ? '▸ ' : '  '}
          {i.kind === 'approval' ? 'Approval' : 'Decision'} · run {i.runId.slice(0, 8)} · {i.nodeId}
          {i.detail.role ? ` · ${i.detail.role}` : ''}: {i.prompt}
        </Text>
      ))}
      <Text color={colors.muted}>j/k select · a approve · d deny · esc back</Text>
    </Box>
  );
}
