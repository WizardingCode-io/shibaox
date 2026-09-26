import { createContext, type JSX, type ParentProps, useContext } from 'solid-js';

const Context = createContext<(code: number) => void>();

export function ExitProvider(props: ParentProps<{ onExit: (code: number) => void }>): JSX.Element {
  return <Context.Provider value={props.onExit}>{props.children}</Context.Provider>;
}

export function useExit(): (code: number) => void {
  const c = useContext(Context);
  if (!c) throw new Error('useExit outside ExitProvider');
  return c;
}
