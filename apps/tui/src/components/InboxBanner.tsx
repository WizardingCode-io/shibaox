import type { InboxItem } from '@shibaox/daemon';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

export interface InboxBannerProps {
  items: InboxItem[];
  width: number;
}

/** The oldest inbox item and its keys; nothing when the inbox is empty. */
export function InboxBanner({ items, width }: InboxBannerProps) {
  const first = items[0];
  if (!first) return null;
  const where = [`run ${first.runId.slice(0, 8)}`, first.nodeId, first.detail.role].filter(Boolean);
  return (
    <Box width={width}>
      <Text color={colors.attention} bold wrap="truncate">
        ▲ Needs you ({items.length}): {first.prompt} · {where.join(' · ')}
        {'   '}
      </Text>
      <Text color={colors.muted}>[a]pprove [d]eny [n]ote{items.length > 1 ? ' [i]nbox' : ''}</Text>
    </Box>
  );
}
