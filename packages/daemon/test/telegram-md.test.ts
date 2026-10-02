import { describe, expect, it } from 'vitest';
import { markdownToTelegramHtml, splitMarkdown } from '../src/channels/telegram-md.js';

describe('markdown → Telegram HTML', () => {
  it('headings become bold lines; bold, italic, code and links become tags; the rest is escaped', () => {
    const md =
      '## 📊 Análise: **WizardingCode**\n\nText with *em*, `code` & <tags>, [site](https://wizardingcode.io).';
    expect(markdownToTelegramHtml(md)).toBe(
      '<b>📊 Análise: WizardingCode</b>\n\nText with <i>em</i>, <code>code</code> &amp; &lt;tags&gt;, <a href="https://wizardingcode.io">site</a>.',
    );
  });
  it('lists get bullets, numbers stay, fenced code becomes pre, strike and underline work', () => {
    const md = '- one\n  - nested\n1. first\n\n```js\nlet a = 1 < 2;\n```\n~~gone~~ __under__';
    expect(markdownToTelegramHtml(md)).toBe(
      '• one\n  • nested\n1. first\n\n<pre><code class="language-js">let a = 1 &lt; 2;\n</code></pre>\n\n<s>gone</s> <u>under</u>',
    );
  });
  it('never emits an unbalanced tag: a stray * or ** is shown as text', () => {
    expect(markdownToTelegramHtml('5 * 3 = 15 and **unclosed')).toBe('5 * 3 = 15 and **unclosed');
    expect(markdownToTelegramHtml('a_b_c snake_case')).toBe('a_b_c snake_case');
  });
  it('splits at paragraph boundaries under the limit and keeps a code block whole', () => {
    const long = `${'word '.repeat(300).trim()}\n\n\`\`\`\n${'line\n'.repeat(50)}\`\`\`\n\n${'tail '.repeat(100).trim()}`;
    const chunks = splitMarkdown(long, 1600);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1600);
    const code = chunks.find((c) => c.includes('<pre>'));
    expect(code).toBeTruthy();
    expect(code?.match(/<pre>/g)?.length).toBe(1);
    expect(code).toContain('</pre>');
    expect(chunks.join('')).not.toContain('**');
  });
  it('a paragraph longer than the limit is split by lines, then by length', () => {
    const chunks = splitMarkdown('x'.repeat(9000), 4000);
    expect(chunks.map((c) => c.length)).toEqual([4000, 4000, 1000]);
  });
});
