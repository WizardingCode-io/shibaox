import { TextAttributes } from '@opentui/core';
import type { KeyRow } from '@shibaox/daemon';
import { createResource, For, type JSX, Show } from 'solid-js';
import { useClient } from '../../context/client.js';
import { useTheme } from '../../theme/context.js';
import { Dialog, useDialog } from '../../ui/dialog.js';

/** The key vault: every key shibaox knows, set or missing, where it comes from; values masked. */
export function KeysDialog(): JSX.Element {
  const client = useClient();
  const dialog = useDialog();
  const theme = useTheme().surface('dialog');
  const [rows] = createResource<KeyRow[]>(() => client.keys().catch(() => []));
  const sorted = () => [...(rows() ?? [])].sort((a, b) => Number(b.set) - Number(a.set));
  return (
    <Dialog size="large" title="Keys" onClose={() => dialog.close()}>
      <box flexDirection="column" width="100%">
        <Show when={rows.loading}>
          <text fg={theme.text.muted}>Reading the vault…</text>
        </Show>
        <For each={sorted().slice(0, 24)}>
          {(r) => (
            <box height={1} flexShrink={0} flexDirection="row">
              <text
                fg={r.set ? theme.text.feedback.success : theme.text.muted}
                wrapMode="none"
                flexShrink={0}
              >
                {r.set ? '● ' : '○ '}
              </text>
              <text
                fg={theme.text.base}
                attributes={TextAttributes.BOLD}
                wrapMode="none"
                flexShrink={0}
              >
                {r.name.padEnd(28)}
              </text>
              <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                {(r.set ? `${r.masked ?? ''} ${r.source ?? ''}` : 'missing').padEnd(22)}
              </text>
              <text fg={theme.text.muted} wrapMode="none" flexShrink={1}>
                {r.description}
              </text>
            </box>
          )}
        </For>
        <box height={1} flexShrink={0} marginTop={1}>
          <text fg={theme.text.muted} wrapMode="none">
            {'Set one with /key NAME value · remove with shibaox keys unset NAME · esc closes'}
          </text>
        </box>
      </box>
    </Dialog>
  );
}
