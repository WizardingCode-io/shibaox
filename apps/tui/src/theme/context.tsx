import { SyntaxStyle } from '@opentui/core';
import {
  createContext,
  createMemo,
  type JSX,
  onCleanup,
  type ParentProps,
  useContext,
} from 'solid-js';
import { type ResolvedTheme, resolveTheme, syntaxStyles } from './resolve.js';
import shibaox from './shibaox.json' with { type: 'json' };

let cached: ResolvedTheme | undefined;
/** The built-in shibaox theme, resolved once. */
export function defaultTheme(): ResolvedTheme {
  cached ??= resolveTheme(shibaox);
  return cached;
}

const Context = createContext<{ theme: ResolvedTheme; syntax: () => SyntaxStyle }>();

export function ThemeProvider(props: ParentProps<{ theme?: ResolvedTheme }>): JSX.Element {
  const theme = props.theme ?? defaultTheme();
  const syntax = createMemo(() => SyntaxStyle.fromStyles(syntaxStyles(theme)));
  // a native handle: release it with the provider (tests mount many)
  onCleanup(() => syntax().destroy());
  return <Context.Provider value={{ theme, syntax }}>{props.children}</Context.Provider>;
}

export function useTheme(): ResolvedTheme {
  const c = useContext(Context);
  if (!c) throw new Error('useTheme outside ThemeProvider');
  return c.theme;
}

/** The syntax style for `<markdown>`, `<code>` and `<diff>`, memoized per theme. */
export function useSyntax(): SyntaxStyle {
  const c = useContext(Context);
  if (!c) throw new Error('useSyntax outside ThemeProvider');
  return c.syntax();
}
