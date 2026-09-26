import { useStdout } from 'ink';
import { useEffect, useState } from 'react';
import type { AppState, AppStore } from './store.js';

/** The store's current state, re-rendering on every change. */
export function useStore(store: AppStore): AppState {
  const [state, setState] = useState(store.get());
  useEffect(() => store.subscribe(setState), [store]);
  return state;
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** The terminal size, following resizes. */
const sizeOf = (stdout: { columns?: number; rows?: number }): TerminalSize => ({
  columns: stdout.columns || 80,
  rows: stdout.rows || 24,
});

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => sizeOf(stdout));
  useEffect(() => {
    const onResize = () => setSize(sizeOf(stdout));
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}
