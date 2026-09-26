import { TextAttributes } from '@opentui/core';
import type { JSX } from 'solid-js';
import { useData } from '../../context/data.js';
import { shortId } from '../../model/format.js';
import { useTheme } from '../../theme/context.js';

/** The text a run was asked for, from its state (`input.spec` for daemon and inline runs). */
export function requestText(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const key of ['spec', 'input', 'text', 'prompt']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

/** The run's request at the top of the conversation: a block with the accent bar on the left. */
export function RequestBlock(props: { runId: string }): JSX.Element {
  const data = useData();
  const theme = useTheme();
  const state = () => data.state.states[props.runId];
  const summary = () => data.state.runs.find((r) => r.runId === props.runId);
  const meta = () => {
    const parts = [
      summary()?.workflow ?? state()?.workflow ?? '',
      state()?.adapter ?? '',
      shortId(props.runId),
    ];
    return parts.filter(Boolean).join(' · ');
  };
  return (
    <box flexDirection="row" width="100%" flexShrink={0} marginBottom={1}>
      <box width={1} flexShrink={0} backgroundColor={theme.text.action.primary.selected} />
      <box
        flexGrow={1}
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.background.raised.base}
      >
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="word">
          {requestText(state()?.input) || '…'}
        </text>
        <box height={1} flexShrink={0}>
          <text fg={theme.text.muted} wrapMode="none">
            {meta()}
          </text>
        </box>
      </box>
    </box>
  );
}
