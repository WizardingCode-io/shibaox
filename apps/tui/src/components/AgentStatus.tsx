import { Text } from 'ink';
import { statusOf } from '../theme.js';

/** A run's state as a symbol plus a word, in the state's colour (never colour alone). */
export function AgentStatus({ status }: { status: string }) {
  const look = statusOf({ status });
  return (
    <Text color={look.color}>
      {look.symbol} {look.word}
    </Text>
  );
}
