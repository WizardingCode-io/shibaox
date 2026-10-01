import { useEffect, useState } from 'react';
import type { RunFileContent } from '../api/client.js';
import { ds } from '../ds.js';
import { numericColumns, parseCsv } from '../markdown/csv.js';
import { highlight, languageOfFile } from '../markdown/highlight.js';
import { Markdown } from '../markdown/render.js';

const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

const iconFor = (path: string): 'table' | 'image' | 'code' | 'file-text' => {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'csv' || ext === 'tsv') return 'table';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (ext === 'md' || ext === 'txt') return 'file-text';
  return languageOfFile(path) ? 'code' : 'file-text';
};

/** The file's body by what it is: a table, a document, coloured code, an image, or a download. */
function Body(props: { file: RunFileContent }): JSX.Element {
  const S = ds();
  const f = props.file;
  const ext = f.path.split('.').pop()?.toLowerCase() ?? '';
  if (f.encoding === 'base64') {
    if (f.mime?.startsWith('image/'))
      return (
        <img
          src={`data:${f.mime};base64,${f.content}`}
          alt={f.path}
          style={{ maxWidth: '100%', borderRadius: 'var(--radius-md)' }}
        />
      );
    return (
      <p className="muted">
        A binary file ({f.mime ?? 'unknown type'}, {bytes(f.size)}): download it to open it.
      </p>
    );
  }
  if (ext === 'csv' || ext === 'tsv') {
    const t = parseCsv(f.content, ext === 'tsv' ? '\t' : undefined);
    if (t) {
      const nums = numericColumns(t);
      return (
        <S.Table
          columns={t.header}
          rows={t.rows}
          align={nums.map((n) => (n ? 'right' : null))}
          caption={`${t.rows.length} row${t.rows.length === 1 ? '' : 's'}${f.truncated ? ' · truncated' : ''}`}
        />
      );
    }
  }
  if (ext === 'md' || ext === 'markdown') return <Markdown text={f.content} />;
  const lang = languageOfFile(f.path);
  return (
    <S.CodeBlock
      language={lang ?? 'text'}
      code={f.content}
      filename={f.path.split('/').pop()}
      wrap={!lang}
    >
      {highlight(f.content, lang)}
    </S.CodeBlock>
  );
}

/**
 * A file a run produced, in the side panel: its content by type, Copy for text, Download for
 * everything. `load` fetches it (the store), `onDownload` saves it.
 */
export function FileSheet(props: {
  runId: string;
  path: string;
  load: (runId: string, path: string) => Promise<RunFileContent>;
  onClose: () => void;
  onDownload: (runId: string, path: string) => void;
}): JSX.Element {
  const S = ds();
  const [file, setFile] = useState<RunFileContent | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    setFile(undefined);
    setError(undefined);
    props
      .load(props.runId, props.path)
      .then((f) => {
        if (live) setFile(f);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [props.load, props.runId, props.path]);
  const name = props.path.split('/').pop() ?? props.path;
  const text = file && file.encoding === 'utf8' ? file.content : undefined;
  return (
    <S.Sheet
      open
      onClose={props.onClose}
      title={name}
      subtitle={
        file
          ? `${props.path} · ${bytes(file.size)}${file.truncated ? ' · shown up to 2 MB' : ''}`
          : props.path
      }
      icon={iconFor(props.path)}
      actions={
        <>
          {text !== undefined ? (
            <S.IconButton
              icon={copied ? 'check' : 'copy'}
              label={copied ? 'Copied' : 'Copy'}
              size="sm"
              onClick={() => {
                try {
                  void navigator.clipboard?.writeText(text);
                } catch {
                  // no clipboard here
                }
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
            />
          ) : null}
          <S.IconButton
            icon="download"
            label="Download"
            size="sm"
            onClick={() => props.onDownload(props.runId, props.path)}
          />
        </>
      }
    >
      {error ? (
        <p className="muted">{error}</p>
      ) : file ? (
        <Body file={file} />
      ) : (
        <S.ThinkingIndicator label="Fetching" />
      )}
    </S.Sheet>
  );
}
