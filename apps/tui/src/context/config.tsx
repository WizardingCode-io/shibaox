import { createContext, type JSX, type ParentProps, useContext } from 'solid-js';

/** Where this instance runs: the CLI version, the shibaox home and the directory it was launched from. */
export interface AppConfig {
  version: string;
  home: string;
  cwd: string;
}

const Context = createContext<AppConfig>();

export function ConfigProvider(props: ParentProps<{ config: AppConfig }>): JSX.Element {
  return <Context.Provider value={props.config}>{props.children}</Context.Provider>;
}

export function useConfig(): AppConfig {
  const c = useContext(Context);
  if (!c) throw new Error('useConfig outside ConfigProvider');
  return c;
}
