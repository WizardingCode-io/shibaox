/**
 * Markdown as the models write it → the HTML subset Telegram renders (b, i, u, s, code, pre, a).
 * Everything else is escaped text. A construct that does not close (a stray `**`, a lone `*`)
 * stays as the text it was: Telegram rejects a message with an unbalanced tag, and a reply that
 * never arrives is worse than a visible asterisk.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline Markdown of one line: code first (its content is literal), then links, bold, italic, strike, underline. */
function inline(line: string): string {
  const out: string[] = [];
  // split on inline code so nothing inside it is touched
  const parts = line.split(/(`[^`\n]+`)/);
  for (const part of parts) {
    if (/^`[^`\n]+`$/.test(part)) {
      out.push(`<code>${escapeHtml(part.slice(1, -1))}</code>`);
      continue;
    }
    let t = escapeHtml(part);
    // links: [text](https://…) — only http(s) targets
    t = t.replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_m, text: string, url: string) => `<a href="${url.replace(/"/g, '%22')}">${text}</a>`,
    );
    // bold: **x** (closed) — never across lines
    t = t.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '<b>$1</b>');
    // underline: __x__
    t = t.replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, '<u>$1</u>');
    // strike: ~~x~~
    t = t.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '<s>$1</s>');
    // italic: *x* with a non-space inside, not part of a word boundary like 5 * 3
    t = t.replace(/(^|[\s(])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');
    // italic: _x_ only when the underscores are not inside a word (snake_case stays)
    t = t.replace(/(^|[\s(])_(?=\S)([^_\n]+?)(?<=\S)_(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');
    out.push(t);
  }
  return out.join('');
}

/** One block of Markdown (a paragraph, a list, a fenced code block) as Telegram HTML. */
function block(md: string): string {
  const fence = /^```([\w-]*)\n([\s\S]*?)\n?```\s*$/.exec(md);
  if (fence) {
    const lang = fence[1] ?? '';
    const code = escapeHtml(fence[2] ?? '');
    return lang
      ? `<pre><code class="language-${lang}">${code}\n</code></pre>`
      : `<pre>${code}\n</pre>`;
  }
  return md
    .split('\n')
    .map((line) => {
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      if (heading) {
        const text = inline((heading[1] ?? '').trim()).replace(/<\/?b>/g, '');
        return `<b>${text}</b>`;
      }
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bullet) return `${bullet[1] ?? ''}• ${inline(bullet[2] ?? '')}`;
      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) return `<i>${inline(quote[1] ?? '')}</i>`;
      if (/^\s*([-*_])\s*\1\s*\1[\s1]*$/.test(line)) return '———';
      return inline(line);
    })
    .join('\n');
}

/** Blocks of a Markdown text: fenced code stays one block; otherwise paragraphs split on blank lines. */
function blocks(md: string): string[] {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    if (cur.length) out.push(cur.join('\n'));
    cur = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!inFence) {
        flush();
        inFence = true;
        cur.push(line.trim());
        continue;
      }
      cur.push('```');
      inFence = false;
      flush();
      continue;
    }
    if (inFence) {
      cur.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    cur.push(line);
  }
  if (inFence) cur.push('```');
  flush();
  return out;
}

/** The whole text as one HTML string (blocks joined by a blank line). */
export function markdownToTelegramHtml(md: string): string {
  return blocks(md).map(block).join('\n\n');
}

/** A string cut into pieces of at most `limit` chars, on line ends when possible. */
function cutHtml(html: string, limit: number): string[] {
  const out: string[] = [];
  let rest = html;
  while (rest.length > limit) {
    let at = rest.lastIndexOf('\n', limit);
    if (at < limit / 2) at = limit;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The text as Telegram messages: each piece is the HTML of whole blocks under `limit`; a block
 * that alone exceeds the limit is cut on line ends (a code block loses its tags then, as text).
 */
export function splitMarkdown(md: string, limit: number): string[] {
  const pieces: string[] = [];
  let cur = '';
  for (const b of blocks(md)) {
    const html = block(b);
    if (html.length > limit) {
      if (cur) pieces.push(cur);
      cur = '';
      const plain =
        html.startsWith('<pre>') || html.startsWith('<pre><code') ? escapeHtml(b) : html;
      pieces.push(...cutHtml(plain, limit));
      continue;
    }
    const next = cur ? `${cur}\n\n${html}` : html;
    if (next.length > limit) {
      pieces.push(cur);
      cur = html;
    } else cur = next;
  }
  if (cur) pieces.push(cur);
  return pieces;
}
