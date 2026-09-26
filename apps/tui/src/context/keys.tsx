import { type KeyEvent, TextareaRenderable } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/solid';
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
 * dialog is modal (only dialog handlers see keys, newest first); a focused text input keeps every
 * plain key for prompt handlers; otherwise prompt handlers, then pane handlers, then global
 * handlers, each newest first, until one consumes the key.
 * ctrl+c exits unless a prompt handler consumes it (clearing its text) or a dialog is open.
 */
export function KeysProvider(props: ParentProps<{ onExit: (code: number) => void }>): JSX.Element {
  const entries: Entry[] = [];
  const renderer = useRenderer();
  useKeyboard((key) => {
    if (key.ctrl && key.name === 'q') return props.onExit(0);
    // a focused text input owns every plain key: only prompt handlers may look at it
    // (they still see ctrl/meta chords and escape through the normal dispatch)
    const typing =
      renderer.currentFocusedRenderable instanceof TextareaRenderable &&
      !key.ctrl &&
      !key.meta &&
      key.name !== 'escape';
    if (entries.some((e) => e.scope === 'dialog')) {
      // modal: every key (ctrl+c included) belongs to the open dialogs, newest handler first
      for (const e of [...entries].reverse()) if (e.scope === 'dialog' && e.handler(key)) return;
      return;
    }
    const ordered = [...entries].reverse();
    const dispatch = (scope: Scope) => ordered.some((e) => e.scope === scope && e.handler(key));
    if (typing) {
      dispatch('prompt');
      return;
    }
    if (key.ctrl && key.name === 'c') {
      if (dispatch('prompt')) return;
      return props.onExit(0);
    }
    if (dispatch('prompt')) return;
    if (dispatch('pane')) return;
    dispatch('global');
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
