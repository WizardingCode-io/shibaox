import { createEffect, createMemo, createResource, type JSX, on } from 'solid-js';
import { Prompt, type PromptRef } from '../../component/prompt/index.js';
import { useClient } from '../../context/client.js';
import { useCommands } from '../../context/commands.js';
import { useData } from '../../context/data.js';
import { useKeys } from '../../context/keys.js';
import {
  DEFAULT_MODEL,
  isModelRef,
  modelCommand,
  type PromptCommandSpec,
} from '../../model/prompt-commands.js';
import { useDialog } from '../../ui/dialog.js';
import { useToast } from '../../ui/toast.js';

const PLACEHOLDERS = ['Continue… "Now add tests for it"', 'Continue… "/diff shows the changes"'];

/**
 * The prompt at the bottom of a finished run: the next request runs in the same tab. `/`
 * offers the commands of this screen (the same ones as the palette): `/diff`, `/cancel`,
 * `/help`, `/home`…
 */
export function ContinuePrompt(props: {
  /** The tab's root run: `/model` applies to its next turns. */
  runId: string;
  onSubmit(text: string): void;
  onScroll?(lines: number): void;
  footer?: JSX.Element;
}): JSX.Element {
  const registry = useCommands();
  const dialog = useDialog();
  const client = useClient();
  const data = useData();
  const toast = useToast();
  const [models] = createResource(() => client.models().catch(() => []));
  let prompt: PromptRef | undefined;
  // a dialog opened from here (diff, help, runs) takes the keys; the prompt gets them back after
  createEffect(
    on(
      dialog.depth,
      (d) => {
        if (d === 0) setTimeout(() => prompt?.focus(), 0);
      },
      { defer: true },
    ),
  );
  // the screen's own commands first, then the shell's
  const ORDER = ['diff', 'cancel', 'resume', 'sidebar', 'home', 'runs', 'help', 'close', 'quit'];
  const rank = (id: string) => {
    const i = ORDER.indexOf(id);
    return i < 0 ? ORDER.length : i;
  };
  const commands = createMemo<PromptCommandSpec[]>(() => [
    modelCommand(() => models() ?? []),
    ...registry
      .commands()
      .filter((c) => c.when?.() ?? true)
      .sort((a, b) => rank(a.id) - rank(b.id))
      .map((c) => ({ name: c.id, kind: 'action' as const, hint: c.label })),
  ]);
  // registered before the prompt mounts: its handler runs after the prompt's, so the arrows
  // scroll the conversation only while no suggestion list is showing
  useKeys('prompt', (key) => {
    const scroll: Record<string, number> = { up: -2, down: 2, pageup: -20, pagedown: 20 };
    const lines = scroll[key.name];
    if (lines === undefined) return false;
    props.onScroll?.(lines);
    return true;
  });
  return (
    <Prompt
      ref={(r) => {
        prompt = r;
      }}
      bare
      disabled={dialog.depth() > 0}
      placeholders={PLACEHOLDERS}
      commands={commands()}
      onSubmit={props.onSubmit}
      onCommand={(cmd) => {
        if (cmd.command === 'model') {
          if (cmd.arg === DEFAULT_MODEL) {
            data.setModel(props.runId, undefined);
            toast.show({ message: 'Next turns follow the org routing', variant: 'info' });
          } else if (!isModelRef(cmd.arg)) {
            toast.show({
              message: 'Model must look like provider/model (see /model for the list)',
              variant: 'error',
            });
          } else {
            data.setModel(props.runId, cmd.arg);
            toast.show({ message: `Next turns run on ${cmd.arg}`, variant: 'info' });
          }
          return;
        }
        registry
          .commands()
          .find((c) => c.id === cmd.command)
          ?.run();
      }}
      footer={props.footer}
    />
  );
}
