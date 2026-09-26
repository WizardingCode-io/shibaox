import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, type JSX, type ParentProps, useContext } from 'solid-js';
import { createStore } from 'solid-js/store';

export interface Prefs {
  lastOrg?: string;
  lastAdapter?: string;
  lastWorkflow?: string;
  animations?: boolean;
  sidebarWidth?: number;
  sidebar?: 'auto' | 'hide';
}

const FILE = 'ui.json';

/** `~/.shibaox/ui.json`; unreadable or malformed means empty. */
export function loadPrefs(home: string): Prefs {
  try {
    const raw = JSON.parse(readFileSync(join(home, FILE), 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as Prefs) : {};
  } catch {
    return {};
  }
}

export function savePrefs(home: string, p: Prefs): void {
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, FILE), `${JSON.stringify(p, null, 2)}\n`);
  } catch {
    // preferences are a convenience; never fail the UI over them
  }
}

const Context = createContext<{ data: Prefs; update: (patch: Partial<Prefs>) => void }>();

export function PrefsProvider(props: ParentProps<{ home: string }>): JSX.Element {
  const [data, set] = createStore<Prefs>(loadPrefs(props.home));
  const update = (patch: Partial<Prefs>) => {
    set(patch);
    savePrefs(props.home, { ...data });
  };
  return <Context.Provider value={{ data, update }}>{props.children}</Context.Provider>;
}

export function usePrefs(): { data: Prefs; update: (patch: Partial<Prefs>) => void } {
  const c = useContext(Context);
  if (!c) throw new Error('usePrefs outside PrefsProvider');
  return c;
}
