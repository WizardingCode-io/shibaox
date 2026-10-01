import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RunFileContent } from '../src/api/client.js';
import { loadDesignSystem } from '../src/ds.js';
import { FileSheet } from '../src/screens/FileSheet.js';

beforeAll(() =>
  loadDesignSystem(
    pathToFileURL(join(process.cwd(), 'vendor/design-system/components/bundle.js')).href,
  ),
);

const sheet = (file: RunFileContent, onClose = () => {}) =>
  render(
    <FileSheet
      runId="r1"
      path={file.path}
      load={async () => file}
      onClose={onClose}
      onDownload={() => {}}
    />,
  );

describe('FileSheet', () => {
  it('shows a CSV as a table, with Copy and Download', async () => {
    sheet({
      path: 'out/clientes.csv',
      size: 30,
      encoding: 'utf8',
      content: 'name,age\n"Silva, Ana",37\nRui,29\n',
      truncated: false,
    });
    const table = await screen.findByRole('table');
    expect(table.querySelectorAll('thead th')).toHaveLength(2);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.textContent).toContain('Silva, Ana');
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy/ })).toBeTruthy();
    expect(screen.getByText('clientes.csv')).toBeTruthy();
  });

  it('renders Markdown as a document and code with colours by extension', async () => {
    const ui = sheet({
      path: 'README.md',
      size: 10,
      encoding: 'utf8',
      content: '# Title\n\nSome **bold**.',
      truncated: false,
    });
    await waitFor(() => expect(ui.container.querySelector('h1')?.textContent).toBe('Title'));
    ui.unmount();
    const code = sheet({
      path: 'src/a.ts',
      size: 10,
      encoding: 'utf8',
      content: 'const a = 1;',
      truncated: false,
    });
    await waitFor(() => expect(code.container.querySelector('.sx-code .tok-keyword')).toBeTruthy());
    expect(code.container.querySelector('.sx-code__bar')?.textContent).toContain('typescript');
  });

  it('a binary file offers Download only; an image shows itself', async () => {
    const ui = sheet({
      path: 'build/app.bin',
      size: 4,
      encoding: 'base64',
      content: 'AAEC',
      truncated: false,
      mime: 'application/octet-stream',
    });
    await screen.findByRole('button', { name: 'Download' });
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
    expect(ui.container.querySelector('.sx-code')).toBeNull();
    expect(screen.getByText(/binary/i)).toBeTruthy();
    ui.unmount();
    const img = sheet({
      path: 'pic.png',
      size: 4,
      encoding: 'base64',
      content: 'iVBORw0KGgo=',
      truncated: false,
      mime: 'image/png',
    });
    await waitFor(() =>
      expect(img.container.querySelector('img')?.src).toContain('data:image/png;base64,'),
    );
  });

  it('Escape and the close button close it; a load error is said', async () => {
    let closed = 0;
    sheet({ path: 'a.txt', size: 1, encoding: 'utf8', content: 'x', truncated: false }, () => {
      closed++;
    });
    await screen.findByText('x');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(closed).toBe(2);
    render(
      <FileSheet
        runId="r1"
        path="gone.txt"
        load={async () => {
          throw new Error('The run workspace is gone');
        }}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await screen.findByText('The run workspace is gone');
  });

  it('an inline file (a code block) shows its code with Copy and Download, and Save to project when a workspace exists', async () => {
    const saved: { path: string; content: string }[] = [];
    const downloads: string[] = [];
    render(
      <FileSheet
        inline={{
          name: 'fibonacci.js',
          content: 'function fibonacci(n) {\n  return n;\n}',
          lang: 'javascript',
        }}
        save={{
          runId: 'r1',
          workspace: '/w/proj',
          write: async (path, content) => {
            saved.push({ path, content });
          },
        }}
        load={async () => {
          throw new Error('not loaded');
        }}
        onClose={() => {}}
        onDownload={() => {}}
        onDownloadInline={(name) => {
          downloads.push(name);
        }}
      />,
    );
    expect(screen.getAllByText('fibonacci.js').length).toBeGreaterThan(0);
    expect(screen.getByText('fibonacci')).toBeTruthy(); // highlighted code
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(downloads).toEqual(['fibonacci.js']);
    const path = screen.getByLabelText('Save to project') as HTMLInputElement;
    expect(path.value).toBe('fibonacci.js');
    fireEvent.change(path, { target: { value: 'scripts/fibonacci.js' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({
      path: 'scripts/fibonacci.js',
      content: 'function fibonacci(n) {\n  return n;\n}',
    });
    await waitFor(() => expect(screen.getByText(/saved to scripts\/fibonacci\.js/i)).toBeTruthy());
  });

  it('an inline file without a workspace offers Download only', () => {
    render(
      <FileSheet
        inline={{ name: 'table.csv', content: 'a,b\n1,2', lang: 'csv' }}
        load={async () => {
          throw new Error('not loaded');
        }}
        onClose={() => {}}
        onDownload={() => {}}
        onDownloadInline={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(screen.queryByLabelText('Save to project')).toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
  });
});
