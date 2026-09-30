import { createSignal, type JSX } from 'solid-js';
import { useData } from '../../context/data.js';
import { useKeys } from '../../context/keys.js';
import { useTheme } from '../../theme/context.js';
import { Dialog, useDialog } from '../../ui/dialog.js';

/** A note for the running task of a run: it stops and starts again with it. */
export function SteerDialog(props: { runId: string }): JSX.Element {
  const data = useData();
  const dialog = useDialog();
  const theme = useTheme().surface('dialog');
  const [value, setValue] = createSignal('');
  const send = () => {
    const note = value().trim();
    if (!note) return;
    dialog.close();
    void data.actions.steer(props.runId, note);
  };
  // modal: the letters typed here never reach the run tab's own keys (s, c, d)
  useKeys('dialog', (key) => {
    if (key.name === 'return') {
      send();
      return true;
    }
    return false;
  });
  return (
    <Dialog size="medium" title="Steer the running task" onClose={() => dialog.close()}>
      <box flexDirection="column">
        <text fg={theme.text.muted} wrapMode="word">
          The task stops and starts again with your note (its session, when it has one, is kept).
        </text>
        <box height={1} flexShrink={0} flexDirection="row" marginTop={1}>
          <text fg={theme.text.action.primary.selected} flexShrink={0}>
            {'› '}
          </text>
          <input
            focused
            placeholder="use pnpm, not npm"
            onInput={setValue}
            flexGrow={1}
            backgroundColor={theme.background.base}
            focusedBackgroundColor={theme.background.base}
            textColor={theme.text.base}
            placeholderColor={theme.text.muted}
            cursorColor={theme.text.action.primary.selected}
          />
        </box>
        <box height={1} flexShrink={0} marginTop={1}>
          <text fg={theme.text.muted} wrapMode="none">
            enter sends · esc closes
          </text>
        </box>
      </box>
    </Dialog>
  );
}
