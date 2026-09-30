import { TextAttributes } from '@opentui/core';
import type { RoutineRow, RoutineTrigger } from '@wizardingcode/shibaox-daemon';
import { createMemo, createResource, createSignal, For, type JSX } from 'solid-js';
import { useClient } from '../../context/client.js';
import { useData } from '../../context/data.js';
import { useKeys } from '../../context/keys.js';
import { age } from '../../model/format.js';
import { useTheme } from '../../theme/context.js';
import { Dialog, useDialog } from '../../ui/dialog.js';
import { useToast } from '../../ui/toast.js';

const VISIBLE = 16;

/** `cron 0 9 * * 1-5`, `github:issues label=bug`, `url https://…`. */
export function triggerLabel(t: RoutineTrigger): string {
  switch (t.type) {
    case 'cron':
      return `cron ${t.cron}`;
    case 'github':
      return `github:${t.watch}${t.label ? ` label=${t.label}` : ''}${t.branch ? ` ${t.branch}` : ''}`;
    case 'url':
      return `url ${t.url}`;
    case 'file':
      return `file ${t.path}`;
    case 'command':
      return `command ${t.command}`;
  }
}

/** The routines the daemon runs on its own: `r` fires the selected one now, `p` pauses or resumes it, enter opens its last run. */
export function RoutinesDialog(): JSX.Element {
  const client = useClient();
  const data = useData();
  const dialog = useDialog();
  const toast = useToast();
  const theme = useTheme().surface('dialog');
  const [cursor, setCursor] = createSignal(0);
  const [rows, { refetch }] = createResource<RoutineRow[]>(() => client.routines().catch(() => []));
  const list = createMemo(() => rows() ?? []);
  const selected = () => list()[Math.min(cursor(), Math.max(0, list().length - 1))];
  const say = (message: string, variant: 'success' | 'error' = 'success') =>
    toast.show({ message, variant });
  useKeys('dialog', (key) => {
    if (key.name === 'up') {
      setCursor((c) => Math.max(0, c - 1));
      return true;
    }
    if (key.name === 'down') {
      setCursor((c) => Math.min(list().length - 1, c + 1));
      return true;
    }
    const r = selected();
    if (!r) return false;
    if (key.name === 'return') {
      if (r.lastRunId) {
        dialog.close();
        data.openRun(r.lastRunId);
      }
      return true;
    }
    if (key.name === 'r' && !key.ctrl) {
      void client
        .runRoutine(r.id)
        .then((x) => {
          say(`routine ${r.name ?? r.id} submitted run ${x.runId.slice(0, 8)}`);
          void refetch();
        })
        .catch((e: unknown) => say(e instanceof Error ? e.message : String(e), 'error'));
      return true;
    }
    if (key.name === 'p' && !key.ctrl) {
      void (r.enabled ? client.pauseRoutine(r.id) : client.resumeRoutine(r.id))
        .then(() => {
          say(`routine ${r.name ?? r.id} ${r.enabled ? 'paused' : 'resumed'}`);
          void refetch();
        })
        .catch((e: unknown) => say(e instanceof Error ? e.message : String(e), 'error'));
      return true;
    }
    return false;
  });
  const start = () =>
    Math.max(0, Math.min(cursor() - Math.floor(VISIBLE / 2), list().length - VISIBLE));
  return (
    <Dialog size="large" title="Routines" onClose={() => dialog.close()}>
      <For each={list().slice(start(), start() + VISIBLE)}>
        {(r, i) => {
          const isSel = () => start() + i() === Math.min(cursor(), list().length - 1);
          const status = () => {
            const run = data.state.runs.find((x) => x.runId === r.lastRunId);
            const last = run
              ? `${run.status} ${age(run.createdAt)}`
              : r.lastFiredAt
                ? `fired ${age(r.lastFiredAt)}`
                : 'never fired';
            return `${r.enabled ? last : 'paused'}${r.source === 'org' ? ' · org' : ''}`;
          };
          return (
            <box
              height={1}
              flexShrink={0}
              flexDirection="row"
              backgroundColor={isSel() ? theme.background.action.primary.selected : undefined}
              onMouseUp={() => setCursor(start() + i())}
            >
              <text
                fg={r.enabled ? theme.text.base : theme.text.muted}
                attributes={isSel() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
              >
                {`${(r.name ?? r.id).padEnd(16).slice(0, 16)} ${triggerLabel(r.trigger)} → ${r.workflow}`}
              </text>
              <box flexGrow={1} />
              <text fg={theme.text.muted} wrapMode="none">
                {status()}
              </text>
            </box>
          );
        }}
      </For>
      <box height={1} flexShrink={0} marginTop={1}>
        <text fg={theme.text.muted} wrapMode="none">
          {rows.loading
            ? 'loading…'
            : list().length === 0
              ? 'No routines: shibaox routine add <workflow> --on "cron:0 9 * * 1-5" …'
              : '↑/↓ select · r run now · p pause/resume · enter open its last run · esc close'}
        </text>
      </box>
    </Dialog>
  );
}
