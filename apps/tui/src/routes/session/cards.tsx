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
      paddingLeft={1}
      backgroundColor={props.selected ? theme.background.action.primary.selected : undefined}
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

/** A task or code node: header line, then the agent's text, tool calls and touched files. */
export function NodeCard(props: {
  card: Card & { kind: 'node' };
  now: number;
  selectedRow?: string;
  expanded: Set<string>;
  rowRef: (id: string, el: unknown) => void;
}): JSX.Element {
  const theme = useTheme();
  const syntax = useSyntax();
  const headerId = () => `card:${props.card.nodeId}`;
  const header = () => {
    const c = props.card;
    const parts = [c.nodeId];
    if (c.role) parts.push(c.role);
    if (c.runtime) parts.push(c.runtime);
    parts.push(`${c.tools} tool${c.tools === 1 ? '' : 's'}`);
    if (c.costUsd !== undefined) parts.push(money(c.costUsd));
    const e = elapsed(c, props.now);
    if (e) parts.push(e);
    return parts.join(' · ');
  };
  const collapsed = () => props.expanded.has(headerId());
  return (
    <box flexDirection="column" width="100%" flexShrink={0} marginBottom={1}>
      <Row selected={props.selectedRow === headerId()} ref={(el) => props.rowRef(headerId(), el)}>
        <StatusSymbol status={props.card.status} />
        <FadeInText fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
          {header()}
        </FadeInText>
      </Row>
      <Show when={!collapsed()}>
        <box flexDirection="column" width="100%" paddingLeft={3}>
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
        </box>
      </Show>
    </box>
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
  // no wrapping box: a `width="100%"` box around a tall block breaks the scroll layout
  // no wrapping box and no margin: either one around a tall markdown block breaks the scroll
  // layout in OpenTUI 0.5.12 (the block vanishes); the content's paddingRight keeps the gap
  if (b.kind === 'text')
    return (
      <markdown content={b.text} syntaxStyle={props.syntax} streaming={props.running} conceal />
    );
  if (b.kind === 'file')
    return (
      <box height={1} flexShrink={0}>
        <text fg={theme.text.muted}>{`± ${b.path}`}</text>
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

/** `> Read src/a.ts · 7 ms · done`; expanded, the input and output follow. */
export function ToolLine(props: {
  block: Block & { kind: 'tool' };
  selected: boolean;
  expanded: boolean;
  ref?: (el: unknown) => void;
  syntax: ReturnType<typeof useSyntax>;
}): JSX.Element {
  const theme = useTheme();
  const line = () => {
    const b = props.block;
    const parts = [`> ${b.name} ${b.summary}`.trimEnd()];
    if (b.ms !== undefined) parts.push(`${b.ms} ms`);
    parts.push(b.status === 'running' ? 'running…' : b.status);
    return parts.join(' · ');
  };
  const output = () => {
    const o = props.block.output;
    const s = typeof o === 'string' ? o : (JSON.stringify(o, null, 2) ?? '');
    return s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}\n…` : s;
  };
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <Row selected={props.selected} ref={props.ref}>
        <text
          fg={props.block.status === 'error' ? theme.text.feedback.error : theme.text.muted}
          wrapMode="none"
        >
          {line()}
        </text>
      </Row>
      <Show when={props.expanded}>
        <box
          flexDirection="column"
          width="100%"
          paddingLeft={3}
          backgroundColor={theme.background.raised.base}
        >
          <text
            fg={theme.text.muted}
            wrapMode="none"
          >{`input ${summarizeInput(props.block.input, 200)}`}</text>
          <Show when={props.block.output !== undefined}>
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
    <box flexDirection="column" width="100%" flexShrink={0} marginBottom={1}>
      <Row selected={props.selected} ref={(el) => props.rowRef(id(), el)}>
        <StatusSymbol status={props.card.status} />
        <FadeInText fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
          {`${props.card.nodeId} · gate${props.card.attempts > 1 ? ` · attempt ${props.card.attempts}` : ''}`}
        </FadeInText>
      </Row>
      <box flexDirection="column" paddingLeft={3}>
        <For each={props.card.checks}>
          {(c) => (
            <box height={1} flexShrink={0}>
              <text
                fg={c.passed ? theme.text.feedback.success : theme.text.feedback.error}
                wrapMode="none"
              >
                {`${c.passed ? '✓' : '✗'} ${c.name}${c.ms !== undefined ? ` · ${c.ms} ms` : ''}`}
              </text>
            </box>
          )}
        </For>
        <Show when={props.card.report}>
          <text fg={theme.text.muted} wrapMode="word">
            {props.card.report ?? ''}
          </text>
        </Show>
      </box>
    </box>
  );
}

export function DecideCard(props: {
  card: Card & { kind: 'decide' };
  selected: boolean;
  rowRef: (id: string, el: unknown) => void;
}): JSX.Element {
  const theme = useTheme();
  const id = () => `card:${props.card.nodeId}`;
  const line = () => {
    const c = props.card;
    if (!c.choice) return `${c.nodeId} · deciding…`;
    return `${c.nodeId} → ${c.choice}${c.confidence !== undefined ? ` (${c.confidence.toFixed(2)})` : ''}`;
  };
  return (
    <box flexDirection="column" width="100%" flexShrink={0} marginBottom={1}>
      <Row selected={props.selected} ref={(el) => props.rowRef(id(), el)}>
        <StatusSymbol status={props.card.status} />
        <FadeInText fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
          {line()}
        </FadeInText>
      </Row>
    </box>
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
    <box flexDirection="column" width="100%" flexShrink={0} marginBottom={1}>
      <Row selected={props.selected} ref={(el) => props.rowRef(id(), el)}>
        <text fg={props.card.pending ? theme.text.feedback.warning : theme.text.feedback.success}>
          {props.card.pending ? '▲ ' : '✓ '}
        </text>
        <FadeInText fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
          {`${props.card.nodeId} · ${props.card.prompt}`}
        </FadeInText>
      </Row>
      <box height={1} flexShrink={0} paddingLeft={3}>
        <text
          fg={props.card.answer?.approved === false ? theme.text.feedback.error : theme.text.muted}
          wrapMode="none"
        >
          {answer()}
        </text>
      </box>
    </box>
  );
}

export function ErrorCard(props: { card: Card & { kind: 'error' } }): JSX.Element {
  const theme = useTheme();
  return (
    <box
      width="100%"
      flexShrink={0}
      marginBottom={1}
      paddingLeft={1}
      backgroundColor={theme.background.feedback.error}
    >
      <text fg={theme.text.feedback.error} wrapMode="word">
        {`✗ ${props.card.nodeId ? `${props.card.nodeId}: ` : ''}${props.card.message}`}
      </text>
    </box>
  );
}

export function EarlierCard(props: { card: Card & { kind: 'earlier' } }): JSX.Element {
  const theme = useTheme();
  return (
    <box height={1} flexShrink={0} marginBottom={1} paddingLeft={1}>
      <text fg={theme.text.muted}>{`… ${props.card.count} earlier`}</text>
    </box>
  );
}

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
    <box
      flexDirection="column"
      width="100%"
      flexShrink={0}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.background.raised.base}
    >
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
        <box paddingLeft={1}>
          <text fg={theme.text.feedback.error} wrapMode="word">
            {props.card.error ?? ''}
          </text>
        </box>
      </Show>
    </box>
  );
}
