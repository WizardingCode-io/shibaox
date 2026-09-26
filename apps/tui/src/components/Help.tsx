import { Box, Text } from 'ink';
import { HELP_LINES } from '../keys.js';
import { colors } from '../theme.js';

export function Help() {
  return (
    <Box flexDirection="column">
      <Text bold color={colors.focus}>
        Keys
      </Text>
      {HELP_LINES.map((l) => (
        <Text key={l}>{l}</Text>
      ))}
      <Text color={colors.muted}>esc back</Text>
    </Box>
  );
}
