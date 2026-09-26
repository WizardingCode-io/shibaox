// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
import { RGBA, TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import {
  type Accessor,
  createContext,
  For,
  type JSX,
  type ParentProps,
  useContext,
} from 'solid-js';
import { createStore } from 'solid-js/store';
import { useKeys } from '../context/keys.js';
import { useTheme } from '../theme/context.js';

export type DialogSize = 'medium' | 'large' | 'xlarge';

export function dialogWidth(size: DialogSize): 60 | 88 | 116 {
  if (size === 'xlarge') return 116;
  if (size === 'large') return 88;
  return 60;
}

/** A modal surface over a dimmed page; esc (or a click outside) calls onClose. */
export function Dialog(
  props: ParentProps<{
    size?: DialogSize;
    centered?: boolean;
    onClose: () => void;
    title?: string;
  }>,
): JSX.Element {
  const dimensions = useTerminalDimensions();
  const theme = useTheme().surface('dialog');
  useKeys('dialog', (key) => {
    if (key.name === 'escape') {
      props.onClose();
      return true;
    }
    return false;
  });
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      zIndex={3000}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      justifyContent={props.centered ? 'center' : undefined}
      paddingTop={props.centered ? 0 : Math.floor(dimensions().height / 4)}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      onMouseUp={() => props.onClose()}
    >
      <box
        width={dialogWidth(props.size ?? 'medium')}
        maxWidth={dimensions().width - 2}
        backgroundColor={theme.background.base}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="column"
        onMouseUp={(e: { stopPropagation(): void }) => e.stopPropagation()}
      >
        {props.title ? (
          <box height={1} flexShrink={0} marginBottom={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
              {props.title}
            </text>
          </box>
        ) : null}
        {props.children}
      </box>
    </box>
  );
}

export interface DialogApi {
  open(element: () => JSX.Element, o?: { onClose?: () => void }): void;
  close(): void;
  clear(): void;
  depth: Accessor<number>;
}

const Context = createContext<DialogApi>();

/** Keeps the dialog stack and draws it above the page. */
export function DialogProvider(props: ParentProps): JSX.Element {
  const [store, setStore] = createStore({
    stack: [] as { element: () => JSX.Element; onClose?: () => void }[],
  });
  const api: DialogApi = {
    open(element, o) {
      setStore('stack', (s) => [...s, { element, onClose: o?.onClose }]);
    },
    close() {
      const top = store.stack.at(-1);
      if (!top) return;
      setStore('stack', (s) => s.slice(0, -1));
      top.onClose?.();
    },
    clear() {
      const all = [...store.stack];
      setStore('stack', []);
      for (const d of all) d.onClose?.();
    },
    depth: () => store.stack.length,
  };
  return (
    <Context.Provider value={api}>
      {props.children}
      <For each={store.stack}>{(d) => d.element()}</For>
    </Context.Provider>
  );
}

export function useDialog(): DialogApi {
  const c = useContext(Context);
  if (!c) throw new Error('useDialog outside DialogProvider');
  return c;
}
