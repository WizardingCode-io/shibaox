import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDesignSystem } from '../src/ds.js';
import { Markdown } from '../src/markdown/render.js';

beforeAll(() =>
  loadDesignSystem(
    pathToFileURL(join(process.cwd(), 'vendor/design-system/components/bundle.js')).href,
  ),
);

describe('Markdown', () => {
  it('renders headings, paragraphs, lists, inline code and emphasis as elements, never as raw marks', () => {
    const ui = render(
      <Markdown
        text={
          '## Plan\n\nFirst **bold** and `code` here.\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n---'
        }
      />,
    );
    expect(ui.container.querySelector('h2')?.textContent).toBe('Plan');
    expect(ui.container.querySelector('strong')?.textContent).toBe('bold');
    expect(ui.container.querySelector('code')?.textContent).toBe('code');
    expect(ui.container.querySelectorAll('ul li')).toHaveLength(2);
    expect(ui.container.querySelectorAll('ol li')).toHaveLength(2);
    expect(ui.container.querySelector('blockquote')?.textContent).toContain('quoted');
    expect(ui.container.querySelector('hr')).toBeTruthy();
    expect(ui.container.textContent).not.toContain('##');
    expect(ui.container.textContent).not.toContain('**');
  });

  it('a fenced block becomes the design system CodeBlock with its language and coloured tokens', () => {
    const ui = render(
      <Markdown
        text={'Here:\n\n```javascript\nfunction fib(n) {\n  return n; // done\n}\n```\n'}
      />,
    );
    const block = ui.container.querySelector('.sx-code') as HTMLElement;
    expect(block).toBeTruthy();
    expect(block.querySelector('.sx-code__bar')?.textContent).toContain('javascript');
    expect(block.querySelector('pre code')?.textContent).toBe(
      'function fib(n) {\n  return n; // done\n}',
    );
    expect(block.querySelectorAll('.tok-keyword').length).toBeGreaterThan(0);
    expect(block.querySelector('.tok-comment')?.textContent).toContain('done');
    expect(ui.container.textContent).not.toContain('```');
  });

  it('a GFM table becomes the design system Table', () => {
    render(<Markdown text={'| name | age |\n| --- | --- |\n| Ana | 37 |\n| Rui | 29 |\n'} />);
    const table = screen.getByRole('table');
    expect(table.className).toContain('sx-table');
    expect(table.querySelectorAll('thead th')).toHaveLength(2);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.textContent).toContain('Ana');
  });

  it('links open in a new tab safely; images are shown as links; HTML is text, not markup', () => {
    const ui = render(
      <Markdown
        text={
          'See [the docs](https://example.com/a).\n\n![pic](https://example.com/p.png)\n\n<script>alert(1)</script> and <b>bold?</b>'
        }
      />,
    );
    const a = ui.container.querySelector('a[href="https://example.com/a"]') as HTMLAnchorElement;
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
    expect(ui.container.querySelector('img')).toBeNull();
    expect(ui.container.querySelector('a[href="https://example.com/p.png"]')?.textContent).toBe(
      'pic',
    );
    expect(ui.container.querySelector('script')).toBeNull();
    expect(ui.container.querySelector('b')).toBeNull();
    expect(ui.container.textContent).toContain('<b>bold?</b>');
  });

  it('a fence still open (streaming) already shows as code; task lists are read-only checkboxes', () => {
    const ui = render(<Markdown text={'Start\n\n```ts\nconst a = 1;\nconst b ='} />);
    expect(ui.container.querySelector('.sx-code pre code')?.textContent).toBe(
      'const a = 1;\nconst b =',
    );
    const list = render(<Markdown text={'- [x] done\n- [ ] later'} />);
    const boxes = list.container.querySelectorAll('input[type=checkbox]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
  });

  it('a fence without a language whose body is CSV becomes a Table; a labelled csv fence too', () => {
    const ui = render(
      <Markdown text={'Here:\n\n```\nname,age,ltv\nAna,37,12000\nRui,29,900\n```\n'} />,
    );
    const table = ui.container.querySelector('table.sx-table') as HTMLElement;
    expect(table).toBeTruthy();
    expect(table.querySelectorAll('thead th')).toHaveLength(3);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.querySelector('tbody td.is-num')?.textContent).toBe('37');
    expect(ui.container.querySelector('.sx-code')).toBeNull();
    const plain = render(<Markdown text={'```\njust a line, with a comma\n```'} />);
    expect(plain.container.querySelector('.sx-code')).toBeTruthy();
  });

  it('task list items show their text only, never the [x] mark', () => {
    const ui = render(<Markdown text={'- [x] done\n- [ ] later'} />);
    const items = [...ui.container.querySelectorAll('li.is-task')];
    expect(items.map((li) => li.textContent?.trim())).toEqual(['done', 'later']);
    expect(ui.container.querySelector('li.is-task span p')).toBeNull();
  });

  it('plain mode (user messages): line breaks kept, inline marks only, no blocks', () => {
    const ui = render(<Markdown text={'# todo\n---\nline one\nline two **bold** `x`'} plain />);
    expect(ui.container.querySelector('h1')).toBeNull();
    expect(ui.container.querySelector('hr')).toBeNull();
    expect(ui.container.querySelectorAll('br').length).toBeGreaterThanOrEqual(2);
    expect(ui.container.querySelector('strong')?.textContent).toBe('bold');
    expect(ui.container.querySelector('code')?.textContent).toBe('x');
    expect(ui.container.textContent).toContain('# todo');
  });

  it('entities the model wrote are decoded; javascript: and protocol-relative links are not links', () => {
    const ui = render(
      <Markdown
        text={
          'Tom &amp; Jerry &rarr; 2 &lt; 3\n\n[a](javascript:alert(1)) [b](//evil.example) [c](/runs)'
        }
      />,
    );
    expect(ui.container.textContent).toContain('Tom & Jerry → 2 < 3');
    expect(ui.container.querySelector('a')).toBeNull();
    expect(ui.container.textContent).toContain('a');
  });

  it('while streaming, a dash on the last line is not a setext heading yet', () => {
    const ui = render(<Markdown text={'Intro\n-'} pending />);
    expect(ui.container.querySelector('h2')).toBeNull();
    expect(ui.container.querySelector('p')?.textContent).toBe('Intro');
    const done = render(<Markdown text={'Intro\n- item'} pending />);
    expect(done.container.querySelector('li')?.textContent).toBe('item');
  });

  it('entities inside code spans stay literal', () => {
    const ui = render(<Markdown text={'Use `&amp;` and `&copy;` as written.'} />);
    expect([...ui.container.querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      '&amp;',
      '&copy;',
    ]);
  });

  it('an unlabelled fence of statements or calls is code, not a table', () => {
    for (const body of [
      'const a = 1;\nconst b = 2;',
      'foo(a, b)\nbar(c, d)',
      'color: red;\nmargin: 0;',
      '12:00, started\n12:01, done',
    ]) {
      const ui = render(<Markdown text={`\`\`\`\n${body}\n\`\`\``} />);
      expect(ui.container.querySelector('.sx-code'), body).toBeTruthy();
      expect(ui.container.querySelector('table'), body).toBeNull();
      ui.unmount();
    }
    const labelled = render(<Markdown text={'```csv\na;b\n1;2\n```'} />);
    expect(labelled.container.querySelector('table')).toBeTruthy();
  });

  it('with onOpenCode, every code block and CSV table offers Open with a name for the file', () => {
    const opened: { text: string; lang?: string; name: string }[] = [];
    render(
      <Markdown
        text={
          'A script:\n\n```javascript\nfunction fibonacci(n) {\n  return n;\n}\n```\n\nAnd data:\n\n```csv\nname,total\nAna,10\nRui,20\n```'
        }
        onOpenCode={(c) => opened.push(c)}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: /open/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(opened[0]).toEqual({
      text: 'function fibonacci(n) {\n  return n;\n}',
      lang: 'javascript',
      name: 'fibonacci.js',
    });
    fireEvent.click(buttons[1] as HTMLElement);
    expect(opened[1]).toMatchObject({ lang: 'csv', name: 'table.csv' });
    expect(opened[1]?.text).toBe('name,total\nAna,10\nRui,20');
  });

  it('without onOpenCode there is no Open control', () => {
    render(<Markdown text={'```js\nlet a = 1;\n```'} />);
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull();
  });

  it('an image whose path is a file of the run renders through renderImage; web images stay links', () => {
    const asked: string[] = [];
    const ui = render(
      <Markdown
        text={'Done:\n\n![A shiba](outputs/shiba.png)\n\nAnd ![logo](https://example.com/logo.png)'}
        renderImage={(path, alt) => {
          asked.push(`${path}|${alt}`);
          return <img alt={alt} src={`data:image/png;base64,${path}`} />;
        }}
      />,
    );
    expect(asked).toEqual(['outputs/shiba.png|A shiba']);
    expect(ui.container.querySelector('img')?.getAttribute('alt')).toBe('A shiba');
    expect(ui.container.querySelector('a[href="https://example.com/logo.png"]')).toBeTruthy();
  });
});
