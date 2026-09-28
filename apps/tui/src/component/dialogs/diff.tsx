import { extname } from 'node:path';
import { TextAttributes } from '@opentui/core';
import type { DiffResult } from '@wizardingcode/shibaox-daemon';
import { DaemonHttpError } from '@wizardingcode/shibaox-daemon/client';
import { createMemo, createResource, createSignal, For, type JSX, Show } from 'solid-js';
import { useClient } from '../../context/client.js';
import { useKeys } from '../../context/keys.js';
import { Spinner } from '../../motion/spinner.js';
import { useSyntax, useTheme } from '../../theme/context.js';
import { Dialog, useDialog } from '../../ui/dialog.js';

const LIST_WIDTH = 24;
const FILETYPES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.json': 'json',
  '.md': 'markdown',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.sh': 'bash',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.css': 'css',
  '.html': 'html',
};

/** The part of a multi-file patch that belongs to `path`. */
export function patchOf(patch: string, path: string): string {
  const header = `diff --git a/${path} b/${path}`;
  const start = patch.indexOf(header);
  if (start < 0) return '';
  const next = patch.indexOf('\ndiff --git ', start + header.length);
  return next < 0 ? patch.slice(start) : patch.slice(start, next + 1);
}

/** The run's changes: a file list on the left, the selected file's diff on the right. */
export function DiffDialog(props: { runId: string }): JSX.Element {
  const client = useClient();
  const dialog = useDialog();
  const theme = useTheme().surface('dialog');
  const syntax = useSyntax();
  const [result] = createResource<{ diff?: DiffResult; error?: string }>(async () => {
    try {
      return { diff: await client.diff(props.runId) };
    } catch (e) {
      if (e instanceof DaemonHttpError && e.code === 'no_workspace')
        return { error: 'Workspace is gone' };
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
  const [cursor, setCursor] = createSignal(0);
  const files = () => result()?.diff?.files ?? [];
  const selected = () => files()[Math.min(cursor(), Math.max(0, files().length - 1))];
  const patch = createMemo(() => {
    const d = result()?.diff;
    const f = selected();
    return d && f ? patchOf(d.patch, f.path) : '';
  });
  const totals = () => {
    const fs = files();
    return `${fs.length} file${fs.length === 1 ? '' : 's'} · +${fs.reduce((a, f) => a + f.additions, 0)} −${fs.reduce((a, f) => a + f.deletions, 0)}`;
  };
  useKeys('dialog', (key) => {
    if (key.name === ']' || key.name === 'down' || key.name === 'j') {
      setCursor((c) => Math.min(files().length - 1, c + 1));
      return true;
    }
    if (key.name === '[' || key.name === 'up' || key.name === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return true;
    }
    return false;
  });
  return (
    <Dialog
      size="xlarge"
      title={result()?.diff ? `Diff · ${totals()}` : 'Diff'}
      onClose={() => dialog.close()}
    >
      <Show
        when={!result.loading}
        fallback={<Spinner color={theme.text.muted}>Reading the workspace…</Spinner>}
      >
        <Show
          when={!result()?.error}
          fallback={<text fg={theme.text.feedback.error}>{result()?.error ?? ''}</text>}
        >
          <Show when={files().length > 0} fallback={<text fg={theme.text.muted}>No changes</text>}>
            <box flexDirection="row" width="100%" height={22}>
              <box width={LIST_WIDTH} flexShrink={0} flexDirection="column" paddingRight={1}>
                <For each={files()}>
                  {(f, i) => (
                    <box
                      height={1}
                      flexShrink={0}
                      backgroundColor={
                        i() === cursor() ? theme.background.action.primary.selected : undefined
                      }
                      onMouseUp={() => setCursor(i())}
                    >
                      <text
                        fg={
                          f.status === 'added'
                            ? theme.diff.added
                            : f.status === 'deleted'
                              ? theme.diff.removed
                              : theme.text.base
                        }
                        attributes={i() === cursor() ? TextAttributes.BOLD : undefined}
                        wrapMode="none"
                      >
                        {`${f.status === 'added' ? '+' : f.status === 'deleted' ? '−' : '±'} ${f.path}`}
                      </text>
                    </box>
                  )}
                </For>
              </box>
              <scrollbox flexGrow={1} height="100%">
                <diff
                  diff={patch()}
                  view="unified"
                  filetype={FILETYPES[extname(selected()?.path ?? '')] ?? 'text'}
                  syntaxStyle={syntax}
                  showLineNumbers
                  addedBg={theme.diff.addedBg}
                  removedBg={theme.diff.removedBg}
                />
              </scrollbox>
            </box>
            <box height={1} flexShrink={0} marginTop={1}>
              <text fg={theme.text.muted} wrapMode="none">
                {`${result()?.diff?.truncated ? '… truncated · ' : ''}] / [ next / previous file · esc close`}
              </text>
            </box>
          </Show>
        </Show>
      </Show>
    </Dialog>
  );
}
