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
    expect(screen.getByText(/No preview/i)).toBeTruthy();
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

  it('opening another block with the same name starts fresh (no stale Saved state)', async () => {
    const save = { runId: 'r1', workspace: '/w', write: async () => {} };
    const props = {
      save,
      load: async () => {
        throw new Error('not loaded');
      },
      onClose: () => {},
      onDownload: () => {},
      onDownloadInline: () => {},
    };
    const ui = render(
      <FileSheet {...props} inline={{ name: 'script.sh', content: 'echo one', lang: 'bash' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/Saved\./)).toBeTruthy());
    ui.rerender(
      <FileSheet {...props} inline={{ name: 'script.sh', content: 'echo two', lang: 'bash' }} />,
    );
    expect(screen.queryByText(/Saved\./)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByText('two')).toBeTruthy();
  });

  it('on the desktop, an inline file offers Open and Save as… through the bridge, and Reveal once saved', async () => {
    const calls: string[] = [];
    (window as unknown as { shibaoxDesktop?: unknown }).shibaoxDesktop = {
      platform: 'darwin',
      saveAs: async (name: string) => {
        calls.push(`saveAs:${name}`);
        return '/Users/me/Downloads/table.csv';
      },
      openWith: async (name: string) => {
        calls.push(`openWith:${name}`);
        return true;
      },
      reveal: async (path: string) => {
        calls.push(`reveal:${path}`);
      },
    };
    try {
      render(
        <FileSheet
          inline={{ name: 'table.csv', content: 'a,b\n1,2', lang: 'csv' }}
          save={{ runId: 'r1', workspace: '/w/proj', write: async () => {} }}
          load={async () => {
            throw new Error('not loaded');
          }}
          onClose={() => {}}
          onDownload={() => {}}
          onDownloadInline={() => {}}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save as…' }));
      await waitFor(() => expect(calls).toEqual(['openWith:table.csv', 'saveAs:table.csv']));
      expect(screen.getByText(/in proj/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.getByText(/Saved\./)).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
      await waitFor(() => expect(calls[2]).toBe('reveal:/w/proj/table.csv'));
    } finally {
      delete (window as unknown as { shibaoxDesktop?: unknown }).shibaoxDesktop;
    }
  });

  it('previews a ragged CSV as a table, JSON pretty, HTML as code and says when there is no preview', async () => {
    const { unmount } = render(
      <FileSheet
        inline={{ name: 'table.csv', content: 'a,b,c\n1,2\n3,4,5,6', lang: 'csv' }}
        load={async () => {
          throw new Error('x');
        }}
        onClose={() => {}}
        onDownload={() => {}}
        onDownloadInline={() => {}}
      />,
    );
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText(/uneven/i)).toBeTruthy();
    unmount();
    const json = render(
      <FileSheet
        inline={{ name: 'data.json', content: '{"a":1,"b":[1,2]}', lang: 'json' }}
        load={async () => {
          throw new Error('x');
        }}
        onClose={() => {}}
        onDownload={() => {}}
        onDownloadInline={() => {}}
      />,
    );
    expect(json.container.querySelector('.sx-code')?.textContent).toContain('  "a": 1');
    json.unmount();
    const bin = render(
      <FileSheet
        runId="r1"
        path="out/report.xlsx"
        load={async () => ({
          path: 'out/report.xlsx',
          size: 10,
          encoding: 'base64',
          content: 'AAAA',
          truncated: false,
        })}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/No preview for \.xlsx/)).toBeTruthy());
    bin.unmount();
  });

  it('on the desktop, a run file larger than the preview is opened and saved whole, through the full download', async () => {
    const calls: { name: string; bytes: number; encoding?: string }[] = [];
    (window as unknown as { shibaoxDesktop?: unknown }).shibaoxDesktop = {
      platform: 'darwin',
      saveAs: async (name: string, content: string, encoding?: string) => {
        calls.push({ name, bytes: content.length, encoding });
        return { ok: true, path: '/x' };
      },
      openWith: async (name: string, content: string, encoding?: string) => {
        calls.push({ name, bytes: content.length, encoding });
        return { ok: true };
      },
      reveal: async () => {},
    };
    try {
      const whole = new Blob([new Uint8Array(3000)]);
      render(
        <FileSheet
          runId="r1"
          path="out/report.xlsx"
          load={async () => ({
            path: 'out/report.xlsx',
            size: 3000,
            encoding: 'base64',
            content: 'AAAA',
            truncated: true,
          })}
          loadWhole={async () => whole}
          onClose={() => {}}
          onDownload={() => {}}
        />,
      );
      await waitFor(() => expect(screen.getByText(/No preview/)).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Save as…' }));
      await waitFor(() => expect(calls).toHaveLength(1));
      // 3000 bytes as base64 is 4000 chars: the whole file, not the 4-char preview
      expect(calls[0]).toEqual({ name: 'report.xlsx', bytes: 4000, encoding: 'base64' });
    } finally {
      delete (window as unknown as { shibaoxDesktop?: unknown }).shibaoxDesktop;
    }
  });

  it('on the desktop, a refused Open says why; Reveal is hidden when the daemon is not on this machine', async () => {
    (window as unknown as { shibaoxDesktop?: unknown }).shibaoxDesktop = {
      platform: 'darwin',
      saveAs: async () => ({ ok: false, reason: 'cancelled' }),
      openWith: async () => ({ ok: false, reason: 'deploy.sh would run rather than open' }),
      reveal: async () => {},
    };
    try {
      render(
        <FileSheet
          inline={{ name: 'deploy.sh', content: 'echo hi', lang: 'bash' }}
          save={{ runId: 'r1', workspace: '/w/proj', write: async () => 'deploy.sh' }}
          localDaemon={false}
          load={async () => {
            throw new Error('x');
          }}
          onClose={() => {}}
          onDownload={() => {}}
          onDownloadInline={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      await waitFor(() => expect(screen.getByText(/would run rather than open/)).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.getByText(/Saved\./)).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).toBeNull();
    } finally {
      delete (window as unknown as { shibaoxDesktop?: unknown }).shibaoxDesktop;
    }
  });
});
