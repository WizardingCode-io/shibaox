import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunFileContent } from '../api/client.js';
import { blobToBase64, desktopBridge } from '../desktop.js';
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

const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);

/** A video or audio file played from the whole download (a Blob URL, never the token). */
function Media(props: {
  kind: 'video' | 'audio' | 'image';
  /** Identifies the file: the load runs once per file, not per parent render. */
  id: string;
  load: () => Promise<Blob>;
}): JSX.Element {
  const S = ds();
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const loadRef = useRef(props.load);
  loadRef.current = props.load;
  const { id } = props;
  useEffect(() => {
    if (!id) return;
    let live = true;
    let made: string | undefined;
    loadRef
      .current()
      .then((b) => {
        if (!live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);
  if (error) return <p className="muted">{error}</p>;
  if (!url) return <S.ThinkingIndicator label="Fetching" />;
  if (props.kind === 'image')
    return <img src={url} alt="" style={{ maxWidth: '100%', borderRadius: 'var(--radius-md)' }} />;
  return props.kind === 'video' ? (
    // biome-ignore lint/a11y/useMediaCaption: a generated clip has no captions
    <video controls src={url} style={{ maxWidth: '100%', borderRadius: 'var(--radius-md)' }} />
  ) : (
    // biome-ignore lint/a11y/useMediaCaption: a generated clip has no captions
    <audio controls src={url} style={{ width: '100%' }} />
  );
}

/** The file's body by what it is: a table, a document, coloured code, an image, media, or a word. */
function Body(props: {
  file: RunFileContent;
  lang?: string;
  loadWhole?: () => Promise<Blob>;
}): JSX.Element {
  const S = ds();
  const f = props.file;
  const ext = f.path.split('.').pop()?.toLowerCase() ?? '';
  if (props.loadWhole && (VIDEO.has(ext) || AUDIO.has(ext)))
    return <Media kind={VIDEO.has(ext) ? 'video' : 'audio'} id={f.path} load={props.loadWhole} />;
  if (f.encoding === 'base64') {
    // an image past the preview cap: the whole download, like a video
    if (f.mime?.startsWith('image/') && f.truncated && props.loadWhole)
      return <Media kind="image" id={f.path} load={props.loadWhole} />;
    if (f.mime?.startsWith('image/') && !f.truncated)
      return (
        <img
          src={`data:${f.mime};base64,${f.content}`}
          alt={f.path}
          style={{ maxWidth: '100%', borderRadius: 'var(--radius-md)' }}
        />
      );
    return (
      <p className="muted">
        No preview for .{ext || 'this kind'} ({f.mime ?? 'unknown type'}, {bytes(f.size)}
        {f.truncated ? ', larger than the 2 MB shown here' : ''}): open it with the app that reads
        it, or save it.
      </p>
    );
  }
  if (ext === 'csv' || ext === 'tsv' || props.lang === 'csv' || props.lang === 'tsv') {
    const t = parseCsv(f.content, ext === 'tsv' || props.lang === 'tsv' ? '\t' : undefined, {
      loose: true,
    });
    if (t) {
      const nums = numericColumns(t);
      return (
        <S.Table
          columns={t.header}
          rows={t.rows}
          align={nums.map((n) => (n ? 'right' : null))}
          caption={`${t.rows.length} row${t.rows.length === 1 ? '' : 's'}${t.ragged ? ' · uneven rows, shown as they are' : ''}${f.truncated ? ' · truncated' : ''}`}
        />
      );
    }
  }
  if (ext === 'md' || ext === 'markdown' || props.lang === 'md' || props.lang === 'markdown')
    return <Markdown text={f.content} />;
  if (ext === 'json' || props.lang === 'json') {
    let pretty = f.content;
    try {
      pretty = JSON.stringify(JSON.parse(f.content), null, 2);
    } catch {
      // not valid JSON: shown as written
    }
    return (
      <S.CodeBlock language="json" code={pretty} filename={f.path.split('/').pop()}>
        {highlight(pretty, 'json')}
      </S.CodeBlock>
    );
  }
  const lang = languageOfFile(f.path) ?? props.lang;
  return (
    <S.CodeBlock
      language={lang ?? 'text'}
      code={f.content}
      filename={f.path.split('/').pop()}
      wrap={!lang || lang === 'text'}
    >
      {highlight(f.content, lang)}
    </S.CodeBlock>
  );
}

/** A code block the model wrote, shown as a file before it exists anywhere. */
export interface InlineFile {
  name: string;
  content: string;
  lang?: string;
}

/** Where an inline file can be saved: the conversation's run and its workspace. */
export interface SaveTarget {
  runId: string;
  workspace: string;
  /** Writes the file; resolves with the path as the daemon spells it (or nothing: the typed one stands). */
  write: (path: string, content: string) => Promise<string | undefined | void>;
}

/**
 * A file in the side panel: one a run produced (`runId` + `path`, fetched with `load`) or one
 * the model wrote in its reply (`inline`). Copy for text, Download for everything, and for an
 * inline file with a workspace to go to, "Save to project".
 */
export function FileSheet(props: {
  runId?: string;
  path?: string;
  inline?: InlineFile;
  save?: SaveTarget;
  /** Why an inline file cannot be saved right now (a turn is running), shown in the footer. */
  saveNote?: string;
  load: (runId: string, path: string) => Promise<RunFileContent>;
  /** The whole file as a Blob (the preview stops at 2 MB): what the desktop opens and saves. */
  loadWhole?: (runId: string, path: string) => Promise<Blob>;
  /** Whether the daemon is on this machine (Reveal in Finder makes sense). */
  localDaemon?: boolean;
  onClose: () => void;
  onDownload: (runId: string, path: string) => void;
  onDownloadInline?: (name: string, content: string) => void;
}): JSX.Element {
  const S = ds();
  const { runId, path, inline, load } = props;
  const [loaded, setLoaded] = useState<RunFileContent | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [savePath, setSavePath] = useState(inline?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  // another block, even with the same name, starts fresh
  useEffect(() => {
    setSavePath(inline?.name ?? '');
    setSaved(undefined);
    setSaveError(undefined);
  }, [inline]);
  useEffect(() => {
    if (inline || runId === undefined || path === undefined) return;
    let live = true;
    setLoaded(undefined);
    setError(undefined);
    load(runId, path)
      .then((f) => {
        if (live) setLoaded(f);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [load, runId, path, inline]);
  const file: RunFileContent | undefined = inline
    ? {
        path: inline.name,
        size: new TextEncoder().encode(inline.content).length,
        encoding: 'utf8',
        content: inline.content,
        truncated: false,
      }
    : loaded;
  const shownPath = path ?? inline?.name ?? '';
  const name = shownPath.split('/').pop() ?? shownPath;
  const text = file && file.encoding === 'utf8' ? file.content : undefined;
  const subtitle = saved
    ? `Saved to ${saved}`
    : file
      ? `${inline ? 'From the reply' : shownPath} · ${bytes(file.size)}${file.truncated ? ' · shown up to 2 MB' : ''}`
      : shownPath;
  const desktop = desktopBridge();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const download = () => {
    if (inline) props.onDownloadInline?.(inline.name, inline.content);
    else if (runId !== undefined && path !== undefined) props.onDownload(runId, path);
  };
  // on the desktop: the app that reads the kind, and the native save dialog, always with the
  // whole file (a run file's preview stops at 2 MB: the full download is fetched for it)
  const native = async (what: 'open' | 'saveAs') => {
    if (!desktop || !file) return;
    setBusy(what);
    setActionError(undefined);
    try {
      let content = file.content;
      let encoding = file.encoding;
      if (
        !inline &&
        file.truncated &&
        props.loadWhole &&
        runId !== undefined &&
        path !== undefined
      ) {
        content = await blobToBase64(await props.loadWhole(runId, path));
        encoding = 'base64';
      }
      const r =
        what === 'open'
          ? await desktop.openWith(name, content, encoding)
          : await desktop.saveAs(name, content, encoding);
      if (!r.ok && r.reason !== 'cancelled') setActionError(r.reason);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const folder = props.save?.workspace.split('/').filter(Boolean).pop() ?? '';
  const lang = inline?.lang;
  const loadWhole = props.loadWhole;
  const whole = useMemo(
    () =>
      !inline && loadWhole && runId !== undefined && path !== undefined
        ? () => loadWhole(runId, path)
        : undefined,
    [inline, loadWhole, runId, path],
  );
  const body = useMemo(
    () =>
      file ? (
        <Body file={file} lang={lang} loadWhole={whole} />
      ) : (
        <S.ThinkingIndicator label="Fetching" />
      ),
    [file, lang, whole, S],
  );
  const doSave = async () => {
    if (!props.save || !inline || !savePath.trim()) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const where = await props.save.write(savePath.trim(), inline.content);
      setSaved(typeof where === 'string' && where ? where : savePath.trim());
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <S.Sheet
      open
      onClose={props.onClose}
      title={name}
      subtitle={subtitle}
      icon={iconFor(shownPath)}
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
          {desktop ? (
            <>
              <S.Button
                size="sm"
                variant="secondary"
                icon="external-link"
                loading={busy === 'open'}
                disabled={!file}
                onClick={() => void native('open')}
              >
                Open
              </S.Button>
              <S.Button
                size="sm"
                variant="secondary"
                icon="download"
                loading={busy === 'saveAs'}
                disabled={!file}
                onClick={() => void native('saveAs')}
              >
                Save as…
              </S.Button>
            </>
          ) : (
            <S.IconButton icon="download" label="Download" size="sm" onClick={download} />
          )}
        </>
      }
      footer={
        inline && props.save && !saved ? (
          <form
            className="save-row"
            onSubmit={(e) => {
              e.preventDefault();
              void doSave();
            }}
          >
            <S.Input
              label="Save to project"
              hint={saveError ?? `A path in ${folder} (${props.save.workspace})`}
              error={saveError}
              value={savePath}
              onChange={(e) => setSavePath((e.target as HTMLInputElement).value)}
            />
            <S.Button type="submit" variant="primary" size="sm" loading={saving}>
              Save
            </S.Button>
          </form>
        ) : saved ? (
          <div className="row">
            <p className="muted">Saved. It is now a file of this conversation.</p>
            <span className="grow" />
            {desktop && props.save && props.localDaemon !== false ? (
              <S.Button
                size="sm"
                variant="secondary"
                onClick={() => void desktop.reveal(`${props.save?.workspace}/${saved}`)}
              >
                Reveal in Finder
              </S.Button>
            ) : null}
          </div>
        ) : inline && props.saveNote ? (
          <p className="muted">{props.saveNote}</p>
        ) : undefined
      }
    >
      {actionError ? <p className="muted">{actionError}</p> : null}
      {error ? <p className="muted">{error}</p> : body}
    </S.Sheet>
  );
}
