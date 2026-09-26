import { RGBA, type StyleDefinitionInput } from '@opentui/core';

export type Feedback = 'error' | 'warning' | 'success' | 'info' | 'running';
export type SurfaceName = 'dialog' | 'sidebar' | 'toast';
export type SyntaxToken =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'function'
  | 'type'
  | 'number'
  | 'heading'
  | 'link';

export interface ResolvedTheme {
  text: {
    base: RGBA;
    muted: RGBA;
    action: { primary: { base: RGBA; focused: RGBA; selected: RGBA; disabled: RGBA } };
    feedback: Record<Feedback, RGBA>;
  };
  background: {
    base: RGBA;
    raised: { base: RGBA; high: RGBA; max: RGBA };
    action: { primary: { hovered: RGBA; focused: RGBA; selected: RGBA } };
    feedback: Record<Feedback, RGBA>;
  };
  border: { base: RGBA };
  scrollbar: { base: RGBA };
  diff: { added: RGBA; removed: RGBA; addedBg: RGBA; removedBg: RGBA };
  syntax: Record<SyntaxToken, RGBA>;
  /** The same theme one level up: dialogs, sidebars and toasts sit on a raised surface. */
  surface(name: SurfaceName): ResolvedTheme;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const FEEDBACK: Feedback[] = ['error', 'warning', 'success', 'info', 'running'];
const SYNTAX: SyntaxToken[] = [
  'keyword',
  'string',
  'comment',
  'function',
  'type',
  'number',
  'heading',
  'link',
];

function lookup(root: Json, path: string): Json | undefined {
  let cur: Json | undefined = root;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as { [k: string]: Json })[part];
  }
  return cur;
}

/** Turns `#rrggbb` or a `$a.b.c` reference (recursively) into an RGBA; throws on a dangling ref. */
function color(root: Json, value: Json | undefined, ref: string, depth = 0): RGBA {
  if (typeof value !== 'string' || depth > 16) throw new Error(`theme: unresolved ${ref}`);
  if (value.startsWith('$')) {
    const target = lookup(root, value.slice(1));
    if (target === undefined) throw new Error(`theme: unresolved ${value}`);
    return color(root, target, value, depth + 1);
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`theme: unresolved ${ref}`);
  return RGBA.fromHex(value);
}

function build(root: Json, get: (path: string) => RGBA): ResolvedTheme {
  const feedback = (prefix: string): Record<Feedback, RGBA> =>
    Object.fromEntries(FEEDBACK.map((f) => [f, get(`${prefix}.${f}`)])) as Record<Feedback, RGBA>;
  const theme: ResolvedTheme = {
    text: {
      base: get('text.base'),
      muted: get('text.muted'),
      action: {
        primary: {
          base: get('text.action.primary.base'),
          focused: get('text.action.primary.focused'),
          selected: get('text.action.primary.selected'),
          disabled: get('text.action.primary.disabled'),
        },
      },
      feedback: feedback('text.feedback'),
    },
    background: {
      base: get('background.base'),
      raised: {
        base: get('background.raised.base'),
        high: get('background.raised.high'),
        max: get('background.raised.max'),
      },
      action: {
        primary: {
          hovered: get('background.action.primary.hovered'),
          focused: get('background.action.primary.focused'),
          selected: get('background.action.primary.selected'),
        },
      },
      feedback: feedback('background.feedback'),
    },
    border: { base: get('border.base') },
    scrollbar: { base: get('scrollbar.base') },
    diff: {
      added: get('diff.added'),
      removed: get('diff.removed'),
      addedBg: get('diff.addedBg'),
      removedBg: get('diff.removedBg'),
    },
    syntax: Object.fromEntries(SYNTAX.map((s) => [s, get(`syntax.${s}`)])) as Record<
      SyntaxToken,
      RGBA
    >,
    surface: (name) => raise(theme, name),
  };
  return theme;
}

/** Re-resolves the theme on a raised surface: each background level moves one step up. */
function raise(base: ResolvedTheme, _name: SurfaceName): ResolvedTheme {
  const theme: ResolvedTheme = {
    ...base,
    background: {
      ...base.background,
      base: base.background.raised.base,
      raised: {
        base: base.background.raised.high,
        high: base.background.raised.max,
        max: base.background.raised.max,
      },
    },
    surface: (name) => raise(theme, name),
  };
  return theme;
}

/** Resolves a theme JSON (hue scales + semantic tokens with `$` references) into RGBA tokens. */
export function resolveTheme(json: unknown): ResolvedTheme {
  const root = json as Json;
  const cache = new Map<string, RGBA>();
  const get = (path: string): RGBA => {
    let c = cache.get(path);
    if (!c) {
      c = color(root, lookup(root, path), `$${path}`);
      cache.set(path, c);
    }
    return c;
  };
  return build(root, get);
}

/** What the markdown, code and diff renderables ask a `SyntaxStyle` for. */
export function syntaxStyles(t: ResolvedTheme): Record<string, StyleDefinitionInput> {
  const s = t.syntax;
  return {
    default: { fg: t.text.base },
    conceal: { fg: t.text.muted },
    keyword: { fg: s.keyword },
    'keyword.function': { fg: s.keyword },
    'keyword.return': { fg: s.keyword },
    'keyword.import': { fg: s.keyword },
    string: { fg: s.string },
    'string.special': { fg: s.string },
    comment: { fg: s.comment, italic: true },
    function: { fg: s.function },
    'function.call': { fg: s.function },
    'function.method': { fg: s.function },
    type: { fg: s.type },
    'type.builtin': { fg: s.type },
    number: { fg: s.number },
    boolean: { fg: s.number },
    constant: { fg: s.number },
    operator: { fg: t.text.muted },
    punctuation: { fg: t.text.muted },
    'punctuation.bracket': { fg: t.text.muted },
    variable: { fg: t.text.base },
    property: { fg: t.text.base },
    'markup.heading': { fg: s.heading, bold: true },
    'markup.bold': { fg: t.text.base, bold: true },
    'markup.strong': { fg: t.text.base, bold: true },
    'markup.italic': { fg: t.text.base, italic: true },
    'markup.raw': { fg: s.string },
    'markup.raw.block': { fg: t.text.base },
    'markup.raw.inline': { fg: s.string },
    'markup.link': { fg: s.link, underline: true },
    'markup.link.url': { fg: s.link, underline: true },
    'markup.link.label': { fg: s.link },
    'markup.list': { fg: s.keyword },
    'markup.quote': { fg: t.text.muted, italic: true },
    'markup.strikethrough': { fg: t.text.muted },
    'diff.plus': { fg: t.diff.added },
    'diff.minus': { fg: t.diff.removed },
  };
}
