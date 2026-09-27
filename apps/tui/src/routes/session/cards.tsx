import { TextAttributes } from '@opentui/core';
import { For, type JSX, Show } from 'solid-js';
import { duration, money } from '../../model/format.js';
import { nodeLook, statusOf } from '../../model/status.js';
import type { Block, Card } from '../../model/stream.js';
import { summarizeInput } from '../../model/stream.js';
import { FadeInText } from '../../motion/fade-in-text.js';
import { WORK_SPINNERS } from '../../motion/one-cell-motion.js';
import { OneCellSpinner } from '../../motion/spinner.js';
import { useSyntax, useTheme } from '../../theme/context.js';
import type { Feedback } from '../../theme/resolve.js';

const OUTPUT_LIMIT = 4096;

export interface RowProps {
  selected: boolean;
}

/** One selectable row: highlighted when selected. */
export function Row(
  props: RowProps & { children: JSX.Element; ref?: (el: unknown) => void },
): JSX.Element {
  const theme = useTheme();
  return (
    <box
      ref={props.ref}
      flexDirection="row"
      width="100%"
      flexShrink={0}
      backgroundColor={props.selected ? theme.background.action.primary.selected : undefined}
    >
      {props.children}
    </box>
  );
}

/** A raised surface: the unit of the conversation. */
function Surface(props: { children: JSX.Element; tone?: Feedback }): JSX.Element {
  const theme = useTheme();
  return (
    <box
      flexDirection="column"
      width="100%"
      flexShrink={0}
      marginBottom={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={
        props.tone ? theme.background.feedback[props.tone] : theme.background.raised.base
      }
    >
      {props.children}
    </box>
  );
}

function feedbackColor(theme: ReturnType<typeof useTheme>, f: Feedback | 'muted') {
  return f === 'muted' ? theme.text.muted : theme.text.feedback[f];
}

function StatusSymbol(props: { status: string }): JSX.Element {
  const theme = useTheme();
  const look = () => nodeLook(props.status);
  return (
    <Show
      when={props.status === 'running'}
      fallback={<text fg={feedbackColor(theme, look().feedback)}>{`${look().symbol} `}</text>}
    >
      <OneCellSpinner
        animation={WORK_SPINNERS['block-soft-sweep']}
        color={theme.text.feedback.running}
      />
      <text> </text>
    </Show>
  );
}

function elapsed(card: Card & { kind: 'node' }, now: number): string | undefined {
  if (!card.startedAt) return undefined;
  const from = Date.parse(card.startedAt);
  const to = card.endedAt ? Date.parse(card.endedAt) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  return duration(Math.max(0, to - from));
}

/** Header row of a card: symbol, bold title, and muted details pushed to the right. */
function Header(props: {
  status: string;
  title: string;
  details?: string;
  selected: boolean;
  ref: (el: unknown) => void;
}): JSX.Element {
  const theme = useTheme();
  return (
    <Row selected={props.selected} ref={props.ref}>
      <StatusSymbol status={props.status} />
      <FadeInText
        fg={theme.text.base}
        attributes={TextAttributes.BOLD}
        wrapMode="none"
        flexShrink={1}
      >
        {props.title}
      </FadeInText>
      <box flexGrow={1} flexShrink={0} width={2} />
      <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
        {props.details ?? ''}
      </text>
    </Row>
  );
}

/** A task or code node: header, then the agent's text, tool calls and touched files. */
export function NodeCard(props: {
  card: Card & { kind: 'node' };
  now: number;
  selectedRow?: string;
  expanded: Set<string>;
  rowRef: (id: string, el: unknown) => void;
  /** A conversation turn: the blocks are the reply, without node header or closing line. */
  chat?: boolean;
}): JSX.Element {
  const theme = useTheme();
  const syntax = useSyntax();
  const headerId = () => `card:${props.card.nodeId}`;
  const title = () => {
    const c = props.card;
    const parts = [c.nodeId];
    if (c.role) parts.push(c.role);
    if (c.runtime) parts.push(c.runtime);
    return parts.join(' · ');
  };
  const details = () => {
    const c = props.card;
    const parts = [`${c.tools} tool${c.tools === 1 ? '' : 's'}`];
    if (c.costUsd !== undefined) parts.push(money(c.costUsd));
    const e = elapsed(c, props.now);
    if (e) parts.push(e);
    return parts.join(' · ');
  };
  const collapsed = () => props.expanded.has(headerId());
  const finished = () =>
    props.card.status !== 'running' && props.card.status !== 'pending' && props.card.endedAt;
  const blocks = () => (
    <For each={props.card.blocks}>
      {(block) => (
        <BlockView
          block={block}
          nodeId={props.card.nodeId}
          running={props.card.status === 'running'}
          selectedRow={props.selectedRow}
          expanded={props.expanded}
          rowRef={props.rowRef}
          syntax={syntax}
        />
      )}
    </For>
  );
  if (props.chat)
    return (
      <box flexDirection="column" width="100%" flexShrink={0} paddingLeft={1} marginBottom={1}>
        {blocks()}
      </box>
    );
  return (
    <Surface>
      <Header
        status={props.card.status}
        title={title()}
        details={details()}
        selected={props.selectedRow === headerId()}
        ref={(el) => props.rowRef(headerId(), el)}
      />
      <Show when={!collapsed()}>
        <box flexDirection="column" width="100%" paddingTop={props.card.blocks.length > 0 ? 1 : 0}>
          {blocks()}
        </box>
      </Show>
      <Show when={finished()}>
        <box height={1} flexShrink={0} marginTop={1}>
          <text fg={theme.text.muted} wrapMode="none">
            <span style={{ fg: theme.text.action.primary.selected }}>■ </span>
            {`${props.card.status === 'completed' ? 'done' : props.card.status}${elapsed(props.card, props.now) ? ` · ${elapsed(props.card, props.now)}` : ''}`}
          </text>
        </box>
      </Show>
    </Surface>
  );
}

function BlockView(props: {
  block: Block;
  nodeId: string;
  running: boolean;
  selectedRow?: string;
  expanded: Set<string>;
  rowRef: (id: string, el: unknown) => void;
  syntax: ReturnType<typeof useSyntax>;
}): JSX.Element {
  const theme = useTheme();
  const b = props.block;
  // no wrapping box and no margin: either one around a tall markdown block breaks the scroll
  // layout in OpenTUI 0.5.12 (the block vanishes)
  if (b.kind === 'text')
    return (
      <markdown content={b.text} syntaxStyle={props.syntax} streaming={props.running} conceal />
    );
  if (b.kind === 'file')
    return (
      <box height={1} flexShrink={0}>
        <text fg={theme.text.muted} wrapMode="none">{`± ${b.path}`}</text>
      </box>
    );
  const id = `tool:${props.nodeId}:${b.id}`;
  return (
    <ToolLine
      block={b}
      selected={props.selectedRow === id}
      expanded={props.expanded.has(id)}
      ref={(el) => props.rowRef(id, el)}
      syntax={props.syntax}
    />
  );
}

/** A unified patch for an edit tool call (Claude Code's `Edit`/`Write` inputs), or undefined. */
export function editPatch(
  name: string,
  input: unknown,
): { path: string; patch: string } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const path =
    typeof o.file_path === 'string' ? o.file_path : typeof o.path === 'string' ? o.path : undefined;
  if (!path) return undefined;
  const before =
    typeof o.old_string === 'string' ? o.old_string : /write/i.test(name) ? '' : undefined;
  const after =
    typeof o.new_string === 'string'
      ? o.new_string
      : typeof o.content === 'string'
        ? o.content
        : undefined;
  if (before === undefined || after === undefined) return undefined;
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const body = [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join('\n');
  return {
    path,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${a.length} +1,${b.length} @@\n${body}\n`,
  };
}

/** `⊙ Read src/a.ts` with the duration on the right; expanded, the input and output follow. */
export function ToolLine(props: {
  block: Block & { kind: 'tool' };
  selected: boolean;
  expanded: boolean;
  ref?: (el: unknown) => void;
  syntax: ReturnType<typeof useSyntax>;
}): JSX.Element {
  const theme = useTheme();
  const edit = () => editPatch(props.block.name, props.block.input);
  const label = () => {
    const b = props.block;
    const prefix = b.parentId ? '├ ' : '⊙ ';
    const e = edit();
    const counts = e
      ? ` (+${e.patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length} −${e.patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length})`
      : '';
    return `${prefix}${b.name} ${b.summary}${counts}`.trimEnd();
  };
  const right = () => {
    const b = props.block;
    if (b.status === 'running') return 'running…';
    if (b.status === 'error') return 'error';
    return b.ms !== undefined ? `${b.ms} ms` : '';
  };
  const output = () => {
    const o = props.block.output;
    const s = typeof o === 'string' ? o : (JSON.stringify(o, null, 2) ?? '');
    return s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}\n…` : s;
  };
  const color = () =>
    props.block.status === 'error' ? theme.text.feedback.error : theme.text.muted;
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <Row selected={props.selected} ref={props.ref}>
        <text fg={color()} wrapMode="none" flexShrink={1}>
          {label()}
        </text>
        <box flexGrow={1} flexShrink={0} width={2} />
        <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
          {right()}
        </text>
      </Row>
      <Show when={props.expanded}>
        <box
          flexDirection="column"
          width="100%"
          paddingLeft={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.background.raised.high}
        >
          <Show
            when={edit()}
            fallback={
              <text
                fg={theme.text.muted}
                wrapMode="none"
              >{`input ${summarizeInput(props.block.input, 200)}`}</text>
            }
          >
            {(e) => (
              <diff
                diff={e().patch}
                view="unified"
                filetype="text"
                syntaxStyle={props.syntax}
                addedBg={theme.diff.addedBg}
                removedBg={theme.diff.removedBg}
              />
            )}
          </Show>
          <Show when={props.block.output !== undefined && !edit()}>
            <code content={output()} filetype="text" syntaxStyle={props.syntax} />
          </Show>
        </box>
      </Show>
    </box>
  );
}

export function GateCard(props: {
  card: Card & { kind: 'gate' };
  selected: boolean;
  rowRef: (id: string, el: unknown) => void;
}): JSX.Element {
  const theme = useTheme();
  const id = () => `card:${props.card.nodeId}`;
  return (
    <Surface>
      <Header
        status={props.card.status}
        title={`${props.card.nodeId} · gate`}
        details={props.card.attempts > 1 ? `attempt ${props.card.attempts}` : ''}
        selected={props.selected}
        ref={(el) => props.rowRef(id(), el)}
      />
      <box flexDirection="column" paddingTop={props.card.checks.length > 0 ? 1 : 0}>
        <For each={props.card.checks}>
          {(c) => (
            <box height={1} flexShrink={0}>
              <text
                fg={c.passed ? theme.text.feedback.success : theme.text.feedback.error}
                wrapMode="none"
              >
                {`[${c.passed ? '✓' : '✗'}] ${c.name}${c.ms !== undefined ? ` · ${c.ms} ms` : ''}`}
              </text>
            </box>
          )}
        </For>
        <Show when={props.card.report}>
          <box paddingTop={1}>
            <text fg={theme.text.muted} wrapMode="word">
              {props.card.report ?? ''}
            </text>
          </box>
        </Show>
      </box>
    </Surface>
  );
}

export function DecideCard(props: {
  card: Card & { kind: 'decide' };
  selected: boolean;
  rowRef: (id: string, el: unknown) => void;
}): JSX.Element {
  const id = () => `card:${props.card.nodeId}`;
  const title = () => {
    const c = props.card;
    if (!c.choice) return `${c.nodeId} · deciding…`;
    return `${c.nodeId} → ${c.choice}${c.confidence !== undefined ? ` (${c.confidence.toFixed(2)})` : ''}`;
  };
  return (
    <Surface>
      <Header
        status={props.card.status}
        title={title()}
        selected={props.selected}
        ref={(el) => props.rowRef(id(), el)}
      />
    </Surface>
  );
}

export function HumanCard(props: {
  card: Card & { kind: 'human' };
  selected: boolean;
  rowRef: (id: string, el: unknown) => void;
}): JSX.Element {
  const theme = useTheme();
  const id = () => `card:${props.card.nodeId}`;
  const answer = () => {
    const a = props.card.answer;
    if (!a) return props.card.pending ? 'waiting for you' : 'waiting';
    return `${a.approved ? 'approved' : 'denied'}${a.note ? ` · ${a.note}` : ''}`;
  };
  return (
    <Surface tone={props.card.pending ? 'warning' : undefined}>
      <Row selected={props.selected} ref={(el) => props.rowRef(id(), el)}>
        <text fg={props.card.pending ? theme.text.feedback.warning : theme.text.feedback.success}>
          {props.card.pending ? '▲ ' : '✓ '}
        </text>
        <FadeInText fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
          {`${props.card.nodeId} · ${props.card.prompt}`}
        </FadeInText>
      </Row>
      <box height={1} flexShrink={0}>
        <text
          fg={props.card.answer?.approved === false ? theme.text.feedback.error : theme.text.muted}
          wrapMode="none"
        >
          {answer()}
        </text>
      </box>
    </Surface>
  );
}

export function ErrorCard(props: { card: Card & { kind: 'error' } }): JSX.Element {
  const theme = useTheme();
  return (
    <Surface tone="error">
      <text fg={theme.text.feedback.error} wrapMode="word">
        {`✗ ${props.card.nodeId ? `${props.card.nodeId}: ` : ''}${props.card.message}`}
      </text>
    </Surface>
  );
}

export function EarlierCard(props: { card: Card & { kind: 'earlier' } }): JSX.Element {
  const theme = useTheme();
  return (
    <box height={1} flexShrink={0} marginBottom={1}>
      <text fg={theme.text.muted}>{`… ${props.card.count} earlier`}</text>
    </box>
  );
}

/** The closing line of a finished run: `✓ Done · 5 nodes · $0.0020 · 3m 02s · 4 files changed · branch`. */
export function SummaryCard(props: {
  card: Card & { kind: 'summary' };
  nodes: number;
  selected: boolean;
  rowRef: (id: string, el: unknown) => void;
}): JSX.Element {
  const theme = useTheme();
  const look = () => statusOf({ status: props.card.status });
  const line = () => {
    const c = props.card;
    const parts = [
      `${look().symbol} ${look().word}`,
      `${props.nodes} node${props.nodes === 1 ? '' : 's'}`,
      money(c.costUsd),
    ];
    if (c.durationMs !== undefined) parts.push(duration(c.durationMs));
    parts.push(`${c.files.length} file${c.files.length === 1 ? '' : 's'} changed`);
    if (c.branch) parts.push(c.branch);
    return parts.join(' · ');
  };
  return (
    <box flexDirection="column" width="100%" flexShrink={0} marginBottom={1}>
      <Row selected={props.selected} ref={(el) => props.rowRef('card:summary', el)}>
        <FadeInText
          fg={feedbackColor(theme, look().feedback)}
          attributes={TextAttributes.BOLD}
          wrapMode="none"
        >
          {line()}
        </FadeInText>
      </Row>
      <Show when={props.card.error}>
        <text fg={theme.text.feedback.error} wrapMode="word">
          {props.card.error ?? ''}
        </text>
      </Show>
    </box>
  );
}
