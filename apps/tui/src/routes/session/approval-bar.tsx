import type { InputRenderable } from '@opentui/core';
import type { InboxItem } from '@wizardingcode/shibaox-daemon';
import { createMemo, createSignal, type JSX, Show } from 'solid-js';
import { useData } from '../../context/data.js';
import { useKeys } from '../../context/keys.js';
import { useTheme } from '../../theme/context.js';

export const APPROVAL_KEYS = '[a]pprove [d]eny [n]ote';

/** The pending items of a run (approvals first): the one the keys act on is the first. */
export function pendingFor(inbox: InboxItem[], runId: string): InboxItem[] {
  return inbox
    .filter((i) => i.runId === runId)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'approval' ? -1 : 1));
}

/**
 * Replaces the key hints while the run waits for the user: a approves (an approval of a command
 * asks y first), d denies, n asks for a note and approves with it; esc backs out.
 */
export function ApprovalBar(props: { runId: string }): JSX.Element {
  const data = useData();
  const theme = useTheme();
  const items = createMemo(() => pendingFor(data.state.inbox, props.runId));
  const item = () => items()[0];
  const [mode, setMode] = createSignal<'idle' | 'confirm' | 'note'>('idle');
  const [note, setNote] = createSignal('');

  const answer = (approved: boolean, text?: string) => {
    const i = item();
    if (!i) return;
    setMode('idle');
    setNote('');
    void data.actions.answer(i.id, approved, text || undefined);
  };

  useKeys('pane', (key) => {
    const i = item();
    if (!i || mode() === 'note' || key.ctrl || key.meta) return false;
    if (mode() === 'confirm') {
      if (key.name === 'y') answer(true);
      else if (key.name === 'n' || key.name === 'escape') setMode('idle');
      return true;
    }
    if (key.name === 'a') {
      if (i.kind === 'approval') setMode('confirm');
      else answer(true);
      return true;
    }
    if (key.name === 'd') {
      answer(false);
      return true;
    }
    if (key.name === 'n') {
      // after this key event: the focused renderable receives the key after the listeners,
      // so a synchronously mounted input would get the `n` typed into it
      setTimeout(() => setMode('note'), 0);
      return true;
    }
    return false;
  });
  useKeys('prompt', (key) => {
    if (mode() !== 'note') return false;
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      setMode('idle');
      setNote('');
      return true;
    }
    return false;
  });

  const who = () => {
    const i = item();
    if (!i) return '';
    return i.kind === 'approval'
      ? (i.detail.role ?? i.detail.program ?? '')
      : (i.detail.action ?? i.nodeId);
  };

  return (
    <box height={2} flexShrink={0} flexDirection="column" width="100%">
      <Show
        when={mode() === 'note'}
        fallback={
          <Show
            when={mode() === 'confirm'}
            fallback={
              <box height={1} flexDirection="row">
                <text
                  fg={theme.text.feedback.warning}
                  wrapMode="none"
                >{`▲ ${item()?.prompt ?? ''} · ${who()} · `}</text>
                <text fg={theme.text.base} wrapMode="none">
                  {APPROVAL_KEYS}
                </text>
              </box>
            }
          >
            <box height={1}>
              <text
                fg={theme.text.feedback.warning}
                wrapMode="none"
              >{`Approve ${item()?.prompt ?? ''}? (y/n)`}</text>
            </box>
          </Show>
        }
      >
        <box height={1} flexDirection="row">
          <text fg={theme.text.feedback.warning} flexShrink={0}>
            {'Note · '}
          </text>
          <input
            ref={(r: InputRenderable) => r.focus()}
            focused
            onInput={setNote}
            onSubmit={() => answer(true, note())}
            flexGrow={1}
            backgroundColor={theme.background.raised.base}
            focusedBackgroundColor={theme.background.raised.base}
            textColor={theme.text.base}
            cursorColor={theme.text.feedback.warning}
          />
        </box>
      </Show>
      <box height={1}>
        <text fg={theme.text.muted} wrapMode="none">
          {items().length > 1
            ? `+${items().length - 1} more waiting`
            : item()?.kind === 'approval'
              ? 'a command needs your approval before it runs'
              : 'the workflow waits for your answer'}
        </text>
      </box>
    </box>
  );
}
