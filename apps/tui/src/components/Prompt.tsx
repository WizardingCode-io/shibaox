import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { colors } from '../theme.js';

export interface PromptProps {
  label: string;
  kind: 'confirm' | 'text';
  onSubmit: (value: string | boolean) => void;
  onCancel: () => void;
}

/** One-line confirmation (`y`/`n`) or text input (`enter` submits, `esc` cancels). */
export function Prompt({ label, kind, onSubmit, onCancel }: PromptProps) {
  const [value, setValue] = useState('');
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (kind === 'confirm') {
      if (input === 'y' || input === 'Y') return onSubmit(true);
      if (input === 'n' || input === 'N') return onSubmit(false);
      return;
    }
    if (key.return) return onSubmit(value);
    if (key.backspace || key.delete) return setValue((v) => v.slice(0, -1));
    if (input && !key.ctrl && !key.meta) setValue((v) => v + input);
  });
  return (
    <Box>
      <Text color={colors.focus} bold>
        {label}{' '}
      </Text>
      {kind === 'confirm' ? (
        <Text color={colors.muted}>(y/n)</Text>
      ) : (
        <Text>
          {value}
          <Text color={colors.focus}>▏</Text>
        </Text>
      )}
    </Box>
  );
}
