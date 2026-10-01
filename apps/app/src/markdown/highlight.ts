import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { createElement, type ReactNode } from 'react';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('python', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('php', php);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('ini', ini);

const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  golang: 'go',
  yml: 'yaml',
  md: 'markdown',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  toml: 'ini',
  docker: 'dockerfile',
  patch: 'diff',
};

/** The language highlight.js knows for a fence label or a file extension; undefined → plain text. */
export function languageOf(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const l = label.trim().toLowerCase().split(/[\s{]/)[0] ?? '';
  const name = ALIASES[l] ?? l;
  return hljs.getLanguage(name) ? name : undefined;
}

/** The language for a file name, by its extension. */
export function languageOfFile(path: string): string | undefined {
  const base = path.split('/').pop() ?? path;
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop() : undefined;
  return languageOf(ext);
}

/** highlight.js scope → the design system's token class. */
function tokenClass(scope: string): string | undefined {
  const parts = scope.split(/\s+/).map((p) => p.replace(/^hljs-/, ''));
  for (const p of parts) {
    if (p === 'function_' || p === 'function' || p === 'section' || p === 'selector-id')
      return 'tok-function';
    if (
      p === 'class_' ||
      p === 'type' ||
      p === 'class' ||
      p === 'selector-class' ||
      p === 'built_in'
    )
      return 'tok-type';
  }
  const first = parts[0] ?? '';
  switch (first) {
    case 'keyword':
    case 'literal':
    case 'meta':
    case 'selector-tag':
    case 'template-tag':
      return 'tok-keyword';
    case 'string':
    case 'char.escape':
    case 'regexp':
    case 'meta.string':
    case 'quote':
    case 'symbol':
    case 'link':
      return 'tok-string';
    case 'number':
      return 'tok-number';
    case 'comment':
    case 'doctag':
      return 'tok-comment';
    case 'title':
      return 'tok-function';
    case 'tag':
    case 'name':
      return 'tok-type';
    case 'attr':
    case 'attribute':
    case 'property':
    case 'variable':
    case 'template-variable':
    case 'selector-attr':
    case 'selector-pseudo':
    case 'params':
    case 'bullet':
      return 'tok-attr';
    case 'punctuation':
    case 'operator':
      return 'tok-punct';
    case 'addition':
      return 'tok-diff-add';
    case 'deletion':
      return 'tok-diff-del';
    default:
      return undefined;
  }
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
};
const decodeEntities = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m);

/**
 * The code as React spans with the design system's token classes. highlight.js only ever emits
 * `<span class="hljs-…">`, `</span>` and escaped text, so its output is walked as such: no HTML
 * is ever injected.
 */
export function highlight(code: string, language: string | undefined): ReactNode {
  const lang = languageOf(language);
  if (!lang) return code;
  let html: string;
  try {
    html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return code;
  }
  type Frame = { cls: string | undefined; children: ReactNode[] };
  const root: Frame = { cls: undefined, children: [] };
  const stack: Frame[] = [root];
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null = re.exec(html);
  let key = 0;
  while (m) {
    const top = stack[stack.length - 1] as Frame;
    if (m[1] !== undefined) stack.push({ cls: tokenClass(m[1]), children: [] });
    else if (m[0] === '</span>') {
      if (stack.length > 1) {
        const done = stack.pop() as Frame;
        (stack[stack.length - 1] as Frame).children.push(
          done.cls
            ? createElement('span', { key: key++, className: done.cls }, ...done.children)
            : createElement('span', { key: key++ }, ...done.children),
        );
      }
    } else top.children.push(decodeEntities(m[2] ?? m[3] ?? ''));
    m = re.exec(html);
  }
  while (stack.length > 1) {
    const done = stack.pop() as Frame;
    (stack[stack.length - 1] as Frame).children.push(
      createElement('span', { key: key++, className: done.cls }, ...done.children),
    );
  }
  return root.children;
}
