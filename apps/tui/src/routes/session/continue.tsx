import { createMemo, type JSX } from 'solid-js';
import { Prompt } from '../../component/prompt/index.js';
import { useCommands } from '../../context/commands.js';
import { useKeys } from '../../context/keys.js';
import type { PromptCommandSpec } from '../../model/prompt-commands.js';

const PLACEHOLDERS = ['Continue… "Now add tests for it"', 'Continue… "/diff shows the changes"'];

/**
 * The prompt at the bottom of a finished run: the next request runs in the same tab. `/`
 * offers the commands of this screen (the same ones as the palette): `/diff`, `/cancel`,
 * `/help`, `/home`…
 */
export function ContinuePrompt(props: {
  onSubmit(text: string): void;
  onScroll?(lines: number): void;
  footer?: JSX.Element;
}): JSX.Element {
  const registry = useCommands();
  // the screen's own commands first, then the shell's
  const ORDER = ['diff', 'cancel', 'resume', 'sidebar', 'home', 'runs', 'help', 'close', 'quit'];
  const rank = (id: string) => {
    const i = ORDER.indexOf(id);
    return i < 0 ? ORDER.length : i;
  };
  const commands = createMemo<PromptCommandSpec[]>(() =>
    registry
      .commands()
      .filter((c) => c.when?.() ?? true)
      .sort((a, b) => rank(a.id) - rank(b.id))
      .map((c) => ({ name: c.id, kind: 'action', hint: c.label })),
  );
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
      bare
      placeholders={PLACEHOLDERS}
      commands={commands()}
      onSubmit={props.onSubmit}
      onCommand={(cmd) =>
        registry
          .commands()
          .find((c) => c.id === cmd.command)
          ?.run()
      }
      footer={props.footer}
    />
  );
}
