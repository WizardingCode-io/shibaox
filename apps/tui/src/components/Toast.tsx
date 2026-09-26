import { Text } from 'ink';
import type { AppState } from '../store.js';
import { colors } from '../theme.js';

const toneColor = { success: colors.success, danger: colors.danger, info: colors.running } as const;

/** A short notice (5 s) after an action; empty when there is none. */
export function Toast({ toast }: { toast?: AppState['toast'] }) {
  if (!toast) return <Text>{''}</Text>;
  return <Text color={toneColor[toast.tone]}>{toast.text}</Text>;
}
