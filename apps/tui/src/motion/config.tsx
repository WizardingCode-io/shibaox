import { type Accessor, createContext, type JSX, type ParentProps, useContext } from 'solid-js';

const Context = createContext<Accessor<boolean>>(() => true);

/** Whether animations run; off with `SHIBAOX_NO_MOTION=1` or `prefs.animations === false`. */
export function MotionProvider(props: ParentProps<{ enabled: boolean }>): JSX.Element {
  return <Context.Provider value={() => props.enabled}>{props.children}</Context.Provider>;
}

export function useMotion(): Accessor<boolean> {
  return useContext(Context);
}

export const motionEnabled = (env: NodeJS.ProcessEnv, prefs?: { animations?: boolean }): boolean =>
  env.SHIBAOX_NO_MOTION !== '1' && prefs?.animations !== false;
