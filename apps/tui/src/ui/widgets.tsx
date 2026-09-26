import type { InboxItem } from '@shibaox/daemon';
import type { ReactNode } from 'react';
import type { AppState } from '../store.js';
import type { StreamLine, ToolInfo } from '../stream.js';
import { colors, statusOf, WAVE_FRAMES } from '../theme.js';

/** Design-system `line` and `surface` tokens (dark theme) for chrome. */
export const chrome = {
  line: '#33271e',
  lineStrong: '#7e6856',
  surfaceSunken: '#0d0906',
} as const;

export interface PanelProps {
  title?: string;
  focused?: boolean;
  tone?: 'default' | 'attention' | 'danger';
  width?: number | `${number}%` | 'auto';
  height?: number | `${number}%` | 'auto';
  minWidth?: number;
  maxWidth?: number;
  flexGrow?: number;
  flexShrink?: number;
  children?: ReactNode;
}

/** A rounded panel: `line` border, `shiba-strong` when focused, `warning`/`danger` by tone. */
export function Panel(p: PanelProps) {
  const border =
    p.tone === 'attention'
      ? colors.attention
      : p.tone === 'danger'
        ? colors.danger
        : p.focused
          ? colors.focus
          : chrome.line;
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={border}
      title={p.title}
      titleColor={p.focused || p.tone ? border : colors.muted}
      width={p.width}
      height={p.height}
      minWidth={p.minWidth}
      maxWidth={p.maxWidth}
      flexGrow={p.flexGrow}
      flexShrink={p.flexShrink}
      flexDirection="column"
    >
      {p.children}
    </box>
  );
}

/** A one-row line that a flexGrow sibling (the scrollbox) can never squeeze to zero height. */
export function Line({ children }: { children?: ReactNode }) {
  return (
    <box height={1} flexShrink={0} flexDirection="row">
      {children}
    </box>
  );
}

/** `● Working` in the status colour: symbol plus word, never colour alone (a whole line). */
export function StatusText({ status }: { status: string }) {
  const look = statusOf({ status });
  return <text fg={look.color}>{`${look.symbol} ${look.word}`}</text>;
}

/** The same, usable inside a `<text>` (OpenTUI text only nests spans and strings). */
export function StatusSpan({ status }: { status: string }) {
  const look = statusOf({ status });
  return <span fg={look.color}>{`${look.symbol} ${look.word}`}</span>;
}

const toolLook = (
  tool: ToolInfo,
  motion: boolean,
  frame: number,
): { text: string; color: string } => {
  switch (tool.status) {
    case 'done':
      return { text: 'done', color: colors.success };
    case 'error':
      return { text: 'error', color: colors.danger };
    case 'approval':
      return { text: 'needs approval', color: colors.attention };
    default:
      return {
        text: motion ? (WAVE_FRAMES[frame % WAVE_FRAMES.length] as string) : '…',
        color: colors.running,
      };
  }
};

/** `> name summary  40 ms  done`; the summary is cut so duration and status always show. */
export function ToolLine({
  tool,
  depth,
  motion,
  frame,
  width,
}: {
  tool: ToolInfo;
  depth: 0 | 1;
  motion: boolean;
  frame: number;
  width: number;
}) {
  const look = toolLook(tool, motion, frame);
  const pad = depth === 1 ? '    ' : '';
  const duration = tool.durationMs === undefined ? '' : `  ${tool.durationMs} ms`;
  const tail = `${duration}  ${look.text}`;
  const head = `${pad}> ${tool.name}`;
  const room = Math.max(0, width - head.length - tail.length - 1);
  const summary =
    tool.summary.length > room ? `${tool.summary.slice(0, Math.max(0, room - 1))}…` : tool.summary;
  return (
    <text>
      <span fg={colors.muted}>{`${pad}> `}</span>
      <strong>{tool.name}</strong>
      {summary ? ` ${summary}` : ''}
      <span fg={colors.muted}>{duration}</span>
      {'  '}
      <span fg={look.color}>{look.text}</span>
    </text>
  );
}

/** One stream line of any kind. */
export function StreamLineView({
  line,
  motion,
  frame,
  width,
}: {
  line: StreamLine;
  motion: boolean;
  frame: number;
  width: number;
}) {
  if (line.kind === 'tool' && line.tool)
    return (
      <ToolLine tool={line.tool} depth={line.depth} motion={motion} frame={frame} width={width} />
    );
  const pad = line.depth === 1 ? '    ' : '';
  if (line.kind === 'event' || line.kind === 'session')
    return <text fg={colors.muted}>{`${pad}${line.text}`}</text>;
  return <text>{`${pad}${line.text}`}</text>;
}

/** The oldest inbox item and its keys. */
export function Banner({ items, keys }: { items: InboxItem[]; keys: string }) {
  const first = items[0];
  if (!first) return null;
  const where = [`run ${first.runId.slice(0, 8)}`, first.nodeId, first.detail.role]
    .filter(Boolean)
    .join(' · ');
  return (
    <Panel tone="attention" height={3}>
      <box flexDirection="row" height={1}>
        <box flexShrink={1} minWidth={0}>
          <text fg={colors.attention}>
            <strong>{`▲ Needs you (${items.length}):`}</strong>
            {` ${first.prompt} `}
            <span fg={colors.muted}>{`· ${where}`}</span>
          </text>
        </box>
        <box flexShrink={0}>
          <text fg={colors.muted}>{`   ${keys}`}</text>
        </box>
      </box>
    </Panel>
  );
}

const toneColor = { success: colors.success, danger: colors.danger, info: colors.running } as const;

/** Footer line: the toast when there is one, else the key help. */
export function Footer({ toast, keys }: { toast?: AppState['toast']; keys: string }) {
  return (
    <box height={1} paddingLeft={1}>
      {toast ? (
        <text fg={toneColor[toast.tone]}>{toast.text}</text>
      ) : (
        <text fg={colors.muted}>{keys}</text>
      )}
    </box>
  );
}

/** Keyed stream line elements; built here so the append-only index key is in one place. */
export function streamElements(lines: StreamLine[], motion: boolean, frame: number, width: number) {
  return lines.map((line, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: stream lines are append-only, their position is their identity
    <StreamLineView key={`${i}`} line={line} motion={motion} frame={frame} width={width} />
  ));
}
