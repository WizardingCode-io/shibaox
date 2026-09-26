import {
  type Accessor,
  createContext,
  createSignal,
  type JSX,
  type ParentProps,
  useContext,
} from 'solid-js';

/** An action the palette can run; `when` hides it while false. */
export interface Command {
  id: string;
  label: string;
  keys: string;
  run: () => void;
  when?: () => boolean;
}

interface Registry {
  commands: Accessor<Command[]>;
  register(cmds: Command[]): () => void;
}

const Context = createContext<Registry>();

/** Screens register their commands here so the palette and help can list them. */
export function CommandsProvider(props: ParentProps): JSX.Element {
  const [all, setAll] = createSignal<Command[][]>([]);
  const register = (cmds: Command[]) => {
    setAll((a) => [...a, cmds]);
    return () => setAll((a) => a.filter((c) => c !== cmds));
  };
  return (
    <Context.Provider value={{ commands: () => all().flat(), register }}>
      {props.children}
    </Context.Provider>
  );
}

export function useCommands(): Registry {
  const c = useContext(Context);
  if (!c) throw new Error('useCommands outside CommandsProvider');
  return c;
}
