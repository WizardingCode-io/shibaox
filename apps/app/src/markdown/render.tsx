import { marked, type Token, type Tokens } from 'marked';
import { Fragment, type ReactNode, useMemo } from 'react';
import { ds } from '../ds.js';
import { numericColumns, parseCsv } from './csv.js';
import { highlight } from './highlight.js';

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

const SAFE_HREF = /^(https?:|mailto:|#|\/)/i;
const href = (raw: string): string | undefined =>
  SAFE_HREF.test(raw.trim()) ? raw.trim() : undefined;

function inline(tokens: Token[] | undefined, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  (tokens ?? []).forEach((t, i) => {
    const key = `${keyBase}.${i}`;
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(<Fragment key={key}>{inline(tt.tokens, key)}</Fragment>);
        else out.push(tt.escaped ? decodeEntities(tt.text) : tt.text);
        break;
      }
      case 'escape':
        out.push(decodeEntities((t as Tokens.Escape).text));
        break;
      case 'strong':
        out.push(<strong key={key}>{inline((t as Tokens.Strong).tokens, key)}</strong>);
        break;
      case 'em':
        out.push(<em key={key}>{inline((t as Tokens.Em).tokens, key)}</em>);
        break;
      case 'del':
        out.push(<del key={key}>{inline((t as Tokens.Del).tokens, key)}</del>);
        break;
      case 'codespan':
        out.push(<code key={key}>{decodeEntities((t as Tokens.Codespan).text)}</code>);
        break;
      case 'br':
        out.push(<br key={key} />);
        break;
      case 'link': {
        const l = t as Tokens.Link;
        const h = href(l.href);
        out.push(
          h ? (
            <a
              key={key}
              href={h}
              title={l.title ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {inline(l.tokens, key)}
            </a>
          ) : (
            <Fragment key={key}>{inline(l.tokens, key)}</Fragment>
          ),
        );
        break;
      }
      case 'image': {
        // never fetch what the model wrote: an image is a link to it
        const im = t as Tokens.Image;
        const h = href(im.href);
        out.push(
          h ? (
            <a key={key} href={h} target="_blank" rel="noopener noreferrer">
              {im.text || h}
            </a>
          ) : (
            im.text
          ),
        );
        break;
      }
      case 'html':
        out.push((t as Tokens.HTML).text); // markup from the model is text, never DOM
        break;
      default:
        out.push('raw' in t ? (t as { raw: string }).raw : '');
    }
  });
  return out;
}

function blocks(tokens: Token[], keyBase: string): ReactNode[] {
  const S = ds();
  const out: ReactNode[] = [];
  tokens.forEach((t, i) => {
    const key = `${keyBase}.${i}`;
    switch (t.type) {
      case 'space':
        break;
      case 'heading': {
        const hd = t as Tokens.Heading;
        const Tag = `h${Math.min(Math.max(hd.depth, 1), 4)}` as 'h1' | 'h2' | 'h3' | 'h4';
        out.push(<Tag key={key}>{inline(hd.tokens, key)}</Tag>);
        break;
      }
      case 'paragraph':
        out.push(<p key={key}>{inline((t as Tokens.Paragraph).tokens, key)}</p>);
        break;
      case 'text': {
        const tt = t as Tokens.Text;
        out.push(<p key={key}>{tt.tokens ? inline(tt.tokens, key) : tt.text}</p>);
        break;
      }
      case 'code': {
        const c = t as Tokens.Code;
        const lang = (c.lang ?? '').trim().split(/\s+/)[0] || undefined;
        // a block of comma- or tab-separated values reads as a table, not as code
        const csv =
          lang === 'csv' || lang === 'tsv' || lang === undefined
            ? parseCsv(c.text, lang === 'tsv' ? '\t' : undefined)
            : undefined;
        if (csv && (lang !== undefined || csv.rows.length >= 1)) {
          const nums = numericColumns(csv);
          out.push(
            <S.Table
              key={key}
              columns={csv.header}
              rows={csv.rows}
              align={nums.map((n) => (n ? 'right' : null))}
              caption={`${csv.rows.length} row${csv.rows.length === 1 ? '' : 's'} · ${lang ?? 'csv'}`}
            />,
          );
          break;
        }
        out.push(
          <S.CodeBlock key={key} language={lang ?? 'text'} code={c.text} maxHeight={480}>
            {highlight(c.text, lang)}
          </S.CodeBlock>,
        );
        break;
      }
      case 'blockquote':
        out.push(<blockquote key={key}>{blocks((t as Tokens.Blockquote).tokens, key)}</blockquote>);
        break;
      case 'hr':
        out.push(<hr key={key} />);
        break;
      case 'list': {
        const l = t as Tokens.List;
        const Tag = l.ordered ? 'ol' : 'ul';
        out.push(
          <Tag
            key={key}
            start={l.ordered && l.start !== '' && l.start !== 1 ? Number(l.start) : undefined}
          >
            {l.items.map((it, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: markdown tokens are positional; their place is their identity
              <li key={`${key}.${j}`} className={it.task ? 'is-task' : undefined}>
                {it.task ? (
                  <input type="checkbox" checked={!!it.checked} disabled readOnly />
                ) : null}
                {it.task ? (
                  <span>{blocks(it.tokens, `${key}.${j}`)}</span>
                ) : (
                  blocks(it.tokens, `${key}.${j}`)
                )}
              </li>
            ))}
          </Tag>,
        );
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        out.push(
          <S.Table
            key={key}
            columns={tb.header.map((c, j) => inline(c.tokens, `${key}.h${j}`))}
            align={tb.align}
            rows={tb.rows.map((r, j) => r.map((c, k) => inline(c.tokens, `${key}.${j}.${k}`)))}
          />,
        );
        break;
      }
      case 'html':
        out.push(<p key={key}>{(t as Tokens.HTML).text}</p>);
        break;
      case 'def':
        break;
      default:
        out.push(<p key={key}>{'raw' in t ? (t as { raw: string }).raw : ''}</p>);
    }
  });
  return out;
}

/**
 * The model's text as a document: headings, lists, quotes, tables (the design system's Table),
 * fenced code (CodeBlock with the brand's syntax colours), links that open elsewhere. Markup
 * the model writes stays text. Re-parsed only when the text changes.
 */
export function Markdown(props: { text: string }): JSX.Element {
  const nodes = useMemo(
    () => blocks(marked.lexer(props.text, { gfm: true, breaks: false }), 'md'),
    [props.text],
  );
  return <>{nodes}</>;
}
