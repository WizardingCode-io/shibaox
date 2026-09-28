// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
import { type ColorInput, parseColor, RGBA } from '@opentui/core';
import type { JSX } from '@opentui/solid';
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { useMotion } from './config.js';
import { type OneCellMotion, oneCellFrame } from './one-cell-motion.js';
import { registerSpinner } from './spinner-renderable.js';

registerSpinner();

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A braille spinner with an optional label; without motion it is a still `⋯`. */
export function Spinner(props: { children?: JSX.Element; color?: ColorInput }): JSX.Element {
  const motion = useMotion();
  const color = () => props.color ?? RGBA.defaultForeground();
  return (
    <Show
      when={motion()}
      fallback={
        <text fg={color()}>
          {props.children ? (
            <>
              {'⋯ '}
              {props.children}
            </>
          ) : (
            '⋯'
          )}
        </text>
      }
    >
      <box flexDirection="row" gap={1} flexShrink={props.children ? 1 : 0}>
        <box flexShrink={0}>
          <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
        </box>
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  );
}

/** One cell of motion (octant sweeps) for a working node; without motion a still glyph. */
export function OneCellSpinner(props: {
  animation: OneCellMotion;
  color: ColorInput;
  paused?: boolean;
  still?: string;
}): JSX.Element {
  const motion = useMotion();
  const [elapsed, setElapsed] = createSignal(0);
  const sequenced = () =>
    !!props.animation.intro || !!props.animation.once || !!props.animation.pace;
  const frame = createMemo(() => oneCellFrame(props.animation, elapsed()));
  const base = createMemo(() => parseColor(props.color));
  const color = createMemo(() => {
    if (sequenced()) {
      const c = RGBA.clone(base());
      c.a *= frame().level;
      return c;
    }
    return base();
  });

  createEffect(() => {
    props.animation;
    setElapsed(0);
  });
  createEffect(() => {
    if (!sequenced() || !motion() || props.paused || frame().complete) return;
    let previous = performance.now();
    const timer = setInterval(
      () => {
        const now = performance.now();
        setElapsed((value) => value + (now - previous));
        previous = now;
      },
      Math.max(
        1000 / 60,
        Math.min(40, props.animation.interval / (props.animation.pace?.initial ?? 1)),
      ),
    );
    onCleanup(() => clearInterval(timer));
  });

  return (
    <box width={1} height={1} flexShrink={0}>
      <Show when={motion()} fallback={<text fg={base()}>{props.still ?? '▪'}</text>}>
        <spinner
          frames={sequenced() ? [frame().glyph] : props.animation.frames}
          interval={props.animation.interval}
          autoplay={!props.paused && !sequenced()}
          color={color()}
        />
      </Show>
    </box>
  );
}
