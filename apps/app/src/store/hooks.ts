import { createContext, useContext, useSyncExternalStore } from 'react';
import type { AppState } from './state.js';
import type { AppStore } from './store.js';

export const StoreContext = createContext<AppStore | undefined>(undefined);

export function useStore(): AppStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error('no store in context');
  return s;
}

/** The current state; re-renders on every change. */
export function useAppState(): AppState {
  const store = useStore();
  return useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.get(),
    () => store.get(),
  );
}
