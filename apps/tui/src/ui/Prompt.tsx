import { useKeyboard } from '@opentui/react';
import { useState } from 'react';
import { colors } from '../theme.js';

export interface PromptSpec {
  label: string;
  kind: 'confirm' | 'text';
  onSubmit: (value: string | boolean) => void;
}

/** One-line confirmation (`y`/`n`) or text input (`enter` submits, `esc` cancels). */
export function Prompt({ spec, onCancel }: { spec: PromptSpec; onCancel: () => void }) {
  const [value, setValue] = useState('');
  useKeyboard((key) => {
    if (key.name === 'escape') return onCancel();
    if (spec.kind === 'confirm') {
      if (key.name === 'y') return spec.onSubmit(true);
      if (key.name === 'n') return spec.onSubmit(false);
      return;
    }
    if (key.name === 'return') return spec.onSubmit(value);
  });
  return (
    <box height={1} paddingLeft={1} flexDirection="row">
      <text fg={colors.focus}>
        <strong>{`${spec.label} `}</strong>
      </text>
      {spec.kind === 'confirm' ? (
        <text fg={colors.muted}>(y/n)</text>
      ) : (
        <input focused onInput={setValue} placeholder="" width={40} />
      )}
    </box>
  );
}
