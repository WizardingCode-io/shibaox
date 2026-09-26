// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
import { TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import {
  type Accessor,
  createContext,
  createSignal,
  type JSX,
  onCleanup,
  type ParentProps,
  Show,
  useContext,
} from 'solid-js';
import { useTheme } from '../theme/context.js';
import type { Feedback } from '../theme/resolve.js';
import { SplitBorder } from './border.js';

export interface ToastOptions {
  title?: string;
  message: string;
  variant: Feedback;
  duration: number;
  action?: { label: string; run: () => void };
}
export type ToastInput = Omit<ToastOptions, 'duration'> & { duration?: number };

export interface ToastApi {
  show(t: ToastInput): void;
  error(e: unknown): void;
  pause(): void;
  resume(): void;
  dismiss(): void;
  activate(): void;
  current: Accessor<ToastOptions | undefined>;
  pending: Accessor<number>;
}

const DEFAULT_MS = 5000;

function ToastSurface(props: { toast: ToastOptions; pending: number; api: ToastApi }): JSX.Element {
  const theme = useTheme().surface('toast');
  const dimensions = useTerminalDimensions();
  const [hovered, setHovered] = createSignal(false);
  const hover = (v: boolean) => {
    setHovered(v);
    if (v) props.api.pause();
    else props.api.resume();
  };
  const affordance = () => (
    <text
      flexShrink={0}
      marginLeft={2}
      wrapMode="none"
      attributes={hovered() && props.toast.action ? TextAttributes.BOLD : undefined}
      fg={hovered() ? theme.text.action.primary.selected : theme.text.muted}
    >
      {props.toast.action ? `› ${props.toast.action.label}` : 'x'}
    </text>
  );
  return (
    <box
      position="absolute"
      top={1}
      right={2}
      zIndex={4000}
      maxWidth={Math.min(60, dimensions().width - 6)}
      borderColor={theme.text.feedback[props.toast.variant]}
      border={SplitBorder.border}
      customBorderChars={SplitBorder.customBorderChars}
      onMouseOver={() => hover(true)}
      onMouseOut={() => hover(false)}
      onMouseUp={() => props.api.activate()}
    >
      <box
        width="100%"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.background.raised.high}
      >
        <Show
          when={props.toast.title}
          fallback={
            <box flexDirection="row" width="100%">
              <text fg={theme.text.base} wrapMode="word" flexGrow={1}>
                {props.toast.message}
              </text>
              {affordance()}
            </box>
          }
        >
          <box flexDirection="row" width="100%" marginBottom={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
              {props.toast.title ?? ''}
            </text>
            <box flexGrow={1} />
            {affordance()}
          </box>
          <text fg={theme.text.base} wrapMode="word" width="100%">
            {props.toast.message}
          </text>
        </Show>
        <Show when={props.pending > 0}>
          <text fg={theme.text.muted} marginTop={1}>{`+${props.pending} more`}</text>
        </Show>
      </box>
    </box>
  );
}

/** Draws the current toast (top-right); mount it once, above everything else. */
export function Toast(): JSX.Element {
  const api = useToast();
  return (
    <Show when={api.current()}>
      {(current) => <ToastSurface toast={current()} pending={api.pending()} api={api} />}
    </Show>
  );
}

function init(): ToastApi {
  // signals, not a store: a store would merge the next toast into the current one
  const [current, setCurrent] = createSignal<ToastOptions | undefined>(undefined);
  const [queue, setQueue] = createSignal<ToastOptions[]>([]);
  let timeout: NodeJS.Timeout | undefined;
  let startedAt = 0;
  let remaining = 0;
  let paused = false;

  const clear = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
  };
  const start = (duration: number) => {
    clear();
    remaining = duration;
    startedAt = Date.now();
    timeout = setTimeout(() => dismiss(), duration);
    timeout.unref?.();
  };
  const dismiss = () => {
    clear();
    const next = queue()[0];
    setQueue((q) => q.slice(1));
    setCurrent(next);
    if (!next) {
      paused = false;
      return;
    }
    remaining = next.duration;
    if (!paused) start(next.duration);
  };
  const api: ToastApi = {
    show(input) {
      const t: ToastOptions = { ...input, duration: input.duration ?? DEFAULT_MS };
      if (current()) {
        setQueue((q) => [...q, t]);
        return;
      }
      setCurrent(t);
      start(t.duration);
    },
    error(e) {
      api.show({ variant: 'error', message: e instanceof Error ? e.message : String(e) });
    },
    pause() {
      if (!current() || paused) return;
      paused = true;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
      clear();
    },
    resume() {
      if (!current() || !paused) return;
      paused = false;
      start(remaining);
    },
    dismiss,
    activate() {
      const action = current()?.action;
      paused = false; // the pointer is still over the spot; the next toast must expire on its own
      dismiss();
      action?.run();
    },
    current,
    pending: () => queue().length,
  };
  onCleanup(clear);
  return api;
}

const Context = createContext<ToastApi>();

export function ToastProvider(props: ParentProps): JSX.Element {
  const value = init();
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function useToast(): ToastApi {
  const value = useContext(Context);
  if (!value) throw new Error('useToast outside ToastProvider');
  return value;
}
