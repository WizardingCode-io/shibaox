import {
  type Accessor,
  createContext,
  createSignal,
  type JSX,
  type ParentProps,
  useContext,
} from 'solid-js';

export type Route = { type: 'home' } | { type: 'session'; runId: string };

const Context = createContext<{ data: Accessor<Route>; navigate: (r: Route) => void }>();

export function RouteProvider(props: ParentProps<{ initial?: Route }>): JSX.Element {
  const [data, setData] = createSignal<Route>(props.initial ?? { type: 'home' });
  return <Context.Provider value={{ data, navigate: setData }}>{props.children}</Context.Provider>;
}

export function useRoute(): { data: Accessor<Route>; navigate: (r: Route) => void } {
  const c = useContext(Context);
  if (!c) throw new Error('useRoute outside RouteProvider');
  return c;
}
