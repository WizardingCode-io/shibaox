import type { KeyEvent } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createContext, type JSX, onCleanup, type ParentProps, useContext } from 'solid-js';

export type Scope = 'global' | 'pane' | 'prompt' | 'dialog';
/** Returns true when the key was consumed. */
export type KeyHandler = (key: KeyEvent) => boolean | undefined;

interface Entry {
  scope: Scope;
  handler: KeyHandler;
}

const Context = createContext<{ register(e: Entry): () => void }>();

/**
 * One keyboard listener for the whole app, dispatched by scope: ctrl+q exits always; an open
 * dialog is modal (only dialog handlers see keys, newest first); otherwise the newest prompt, then
 * the newest pane, then every global handler (newest first) until one consumes the key.
 * ctrl+c exits unless a prompt handler consumes it (clearing its text) or a dialog is open.
 */
export function KeysProvider(props: ParentProps<{ onExit: (code: number) => void }>): JSX.Element {
  const entries: Entry[] = [];
  const last = (scope: Scope) => [...entries].reverse().find((e) => e.scope === scope);
  useKeyboard((key) => {
    if (key.ctrl && key.name === 'q') return props.onExit(0);
    if (entries.some((e) => e.scope === 'dialog')) {
      // modal: every key (ctrl+c included) belongs to the open dialogs, newest handler first
      for (const e of [...entries].reverse()) if (e.scope === 'dialog' && e.handler(key)) return;
      return;
    }
    const prompt = last('prompt');
    if (key.ctrl && key.name === 'c') {
      if (prompt?.handler(key)) return;
      return props.onExit(0);
    }
    if (prompt?.handler(key)) return;
    if (last('pane')?.handler(key)) return;
    for (const e of [...entries].reverse()) if (e.scope === 'global' && e.handler(key)) return;
  });
  const register = (e: Entry) => {
    entries.push(e);
    return () => {
      const i = entries.indexOf(e);
      if (i >= 0) entries.splice(i, 1);
    };
  };
  return <Context.Provider value={{ register }}>{props.children}</Context.Provider>;
}

/** Registers a key handler for this component's lifetime. */
export function useKeys(scope: Scope, handler: KeyHandler): void {
  const c = useContext(Context);
  if (!c) throw new Error('useKeys outside KeysProvider');
  const off = c.register({ scope, handler });
  onCleanup(off);
}
