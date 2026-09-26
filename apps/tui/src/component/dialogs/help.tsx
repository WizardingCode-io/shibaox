import { TextAttributes } from '@opentui/core';
import { For, type JSX } from 'solid-js';
import { useTheme } from '../../theme/context.js';
import { Dialog, useDialog } from '../../ui/dialog.js';

type Section = { title: string; keys: [string, string][] };

const LEFT: Section[] = [
  {
    title: 'Global',
    keys: [
      ['ctrl+n', 'home / new run'],
      ['ctrl+o', 'open a run'],
      ['ctrl+k', 'command palette'],
      ['ctrl+b', 'toggle the sidebar'],
      ['ctrl+] · ctrl+p', 'next / previous tab'],
      ['ctrl+w', 'close the tab'],
      ['?', 'this help (outside inputs)'],
      ['ctrl+q', 'quit; runs keep going'],
    ],
  },
  {
    title: 'Dialogs',
    keys: [
      ['esc', 'close'],
      ['↑/↓ · enter', 'choose'],
      ['typing', 'filters'],
    ],
  },
];
const RIGHT: Section[] = [
  {
    title: 'Session',
    keys: [
      ['j/k · ↑/↓', 'cursor · scroll'],
      ['enter', 'expand / collapse'],
      ['g · G', 'top · follow the end'],
      ['d', 'diff (deny while waiting)'],
      ['c', 'cancel the run'],
      ['r', 'resume a paused run'],
      ['a · d · n', 'approve · deny · note'],
      ['tab', 'focus the sidebar'],
    ],
  },
  {
    title: 'Sidebar',
    keys: [
      ['j/k', 'select a run'],
      ['enter', 'open it'],
      ['a · d', 'answer its item'],
      ['tab', 'back'],
    ],
  },
];

function Column(props: { sections: Section[] }): JSX.Element {
  const theme = useTheme().surface('dialog');
  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0}>
      <For each={props.sections}>
        {(s) => (
          <box flexDirection="column" flexShrink={0} marginBottom={1}>
            <text fg={theme.text.action.primary.selected} attributes={TextAttributes.BOLD}>
              {s.title}
            </text>
            <For each={s.keys}>
              {([k, what]) => (
                <box height={1} flexShrink={0} flexDirection="row">
                  <box width={16} flexShrink={0}>
                    <text fg={theme.text.base} wrapMode="none">
                      {k}
                    </text>
                  </box>
                  <text fg={theme.text.muted} wrapMode="none">
                    {what}
                  </text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}

/** Every key, by context, in two columns. */
export function HelpDialog(): JSX.Element {
  const dialog = useDialog();
  return (
    <Dialog size="large" title="Keys" onClose={() => dialog.close()}>
      <box flexDirection="row" width="100%" gap={2}>
        <Column sections={LEFT} />
        <Column sections={RIGHT} />
      </box>
    </Dialog>
  );
}
