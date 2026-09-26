// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
import { type Accessor, createEffect, createSignal, onCleanup } from 'solid-js';

/** True once `source` has been defined for `delay` ms; resets whenever it changes (no flicker under the delay). */
export function createDelayedPresence<T>(
  source: Accessor<T | undefined>,
  delay: number | ((value: T) => number),
): Accessor<boolean> {
  const [visible, setVisible] = createSignal(false);
  createEffect(() => {
    const current = source();
    setVisible(false);
    if (current === undefined) return;
    const remaining = typeof delay === 'function' ? delay(current) : delay;
    if (remaining <= 0) {
      setVisible(true);
      return;
    }
    const timer = setTimeout(() => setVisible(true), remaining);
    onCleanup(() => clearTimeout(timer));
  });
  return visible;
}
