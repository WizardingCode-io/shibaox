import type { Renderable, ScrollBoxRenderable } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  Switch,
} from 'solid-js';
import { useData } from '../../context/data.js';
import { useKeys } from '../../context/keys.js';
import type { Card } from '../../model/stream.js';
import { useTheme } from '../../theme/context.js';
import {
  DecideCard,
  EarlierCard,
  ErrorCard,
  GateCard,
  HumanCard,
  NodeCard,
  SummaryCard,
} from './cards.js';

/** Ids of the rows the cursor can land on: card headers and tool lines, in reading order. */
export function selectableRows(cards: Card[]): string[] {
  const rows: string[] = [];
  for (const c of cards) {
    if (c.kind === 'error' || c.kind === 'earlier') continue;
    if (c.kind === 'summary') {
      rows.push('card:summary');
      continue;
    }
    rows.push(`card:${c.nodeId}`);
    if (c.kind === 'node')
      for (const b of c.blocks) if (b.kind === 'tool') rows.push(`tool:${c.nodeId}:${b.id}`);
  }
  return rows;
}

/**
 * The conversation of a run: its cards in a scrollbox that follows the end until the user
 * scrolls, with a cursor over card headers and tool lines (enter expands or collapses).
 */
export function Timeline(props: {
  runId: string;
  focused: boolean;
  onToggle?: (id: string) => void;
}): JSX.Element {
  const data = useData();
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const cards = data.timeline(props.runId);
  const rows = createMemo(() => selectableRows(cards()));
  const [cursor, setCursor] = createSignal(0);
  const [expanded, setExpanded] = createSignal(new Set<string>(), { equals: false });
  const [now, setNow] = createSignal(Date.now());
  // true until the user scrolls up: the view then follows the newest content
  const [following, setFollowing] = createSignal(true);
  const refs = new Map<string, Renderable>();
  let scroll: ScrollBoxRenderable | undefined;
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));

  // the markdown renderable lays out its text a frame late, which can leave a sticky scrollbox
  // parked past the content: re-stick explicitly after every change while following
  const follow = () => {
    if (!following() || !scroll) return;
    scroll.scrollTo(scroll.scrollHeight);
  };
  // OpenTUI's stickyScroll re-sticks after a programmatic scrollTo(0), so following is ours alone
  createEffect(
    on([cards, dimensions], () => {
      setTimeout(follow, 0);
      setTimeout(follow, 120);
    }),
  );

  const selectedRow = () => rows()[Math.min(cursor(), rows().length - 1)];
  const nodes = createMemo(
    () =>
      cards().filter((c) => c.kind !== 'error' && c.kind !== 'earlier' && c.kind !== 'summary')
        .length,
  );

  const ensureVisible = () => {
    const id = selectedRow();
    const el = id ? refs.get(id) : undefined;
    if (!el || !scroll) return;
    const top = el.y - scroll.viewport.y + scroll.scrollTop;
    if (top < scroll.scrollTop) scroll.scrollTo(top);
    else if (top + el.height > scroll.scrollTop + scroll.viewport.height)
      scroll.scrollTo(top + el.height - scroll.viewport.height);
  };
  // only after a one-row move: right after scrollTo(0)/scrollTo(end) the row positions are stale
  const move = (delta: number) => {
    setCursor((c) => c + delta);
    setTimeout(ensureVisible, 0);
  };

  const toggle = () => {
    const id = selectedRow();
    if (!id) return;
    setExpanded((s) => {
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
    props.onToggle?.(id);
  };

  useKeys('pane', (key) => {
    if (!props.focused || key.ctrl || key.meta) return false;
    const n = rows().length;
    switch (key.name) {
      case 'j':
      case 'down':
        if (cursor() < n - 1) move(1);
        else scroll?.scrollBy(1);
        return true;
      case 'k':
      case 'up':
        setFollowing(false);
        if (cursor() > 0) move(-1);
        else scroll?.scrollBy(-1);
        return true;
      case 'pagedown':
        scroll?.scrollBy(scroll.viewport.height);
        return true;
      case 'pageup':
        setFollowing(false);
        scroll?.scrollBy(-scroll.viewport.height);
        return true;
      case 'g':
        if (key.shift) {
          setFollowing(true);
          setCursor(Math.max(0, n - 1));
          follow();
        } else {
          setFollowing(false);
          setCursor(0);
          scroll?.scrollTo(0);
        }
        return true;
      case 'return':
        toggle();
        return true;
      default:
        return false;
    }
  });

  const rowRef = (id: string, el: unknown) => {
    if (el) refs.set(id, el as Renderable);
    else refs.delete(id);
  };

  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => {
        scroll = r;
      }}
      flexGrow={1}
      width="100%"
      verticalScrollbarOptions={{
        visible: true,
        trackOptions: {
          backgroundColor: theme.background.base,
          foregroundColor: theme.scrollbar.base,
        },
      }}
      horizontalScrollbarOptions={{ visible: false }}
      contentOptions={{ flexDirection: 'column', paddingTop: 1, paddingRight: 1 }}
    >
      <For each={cards()}>
        {(card) => (
          <Switch>
            <Match when={card.kind === 'node' && card}>
              {(c) => (
                <NodeCard
                  card={c()}
                  now={now()}
                  selectedRow={props.focused ? selectedRow() : undefined}
                  expanded={expanded()}
                  rowRef={rowRef}
                />
              )}
            </Match>
            <Match when={card.kind === 'gate' && card}>
              {(c) => (
                <GateCard
                  card={c()}
                  selected={props.focused && selectedRow() === `card:${c().nodeId}`}
                  rowRef={rowRef}
                />
              )}
            </Match>
            <Match when={card.kind === 'decide' && card}>
              {(c) => (
                <DecideCard
                  card={c()}
                  selected={props.focused && selectedRow() === `card:${c().nodeId}`}
                  rowRef={rowRef}
                />
              )}
            </Match>
            <Match when={card.kind === 'human' && card}>
              {(c) => (
                <HumanCard
                  card={c()}
                  selected={props.focused && selectedRow() === `card:${c().nodeId}`}
                  rowRef={rowRef}
                />
              )}
            </Match>
            <Match when={card.kind === 'error' && card}>{(c) => <ErrorCard card={c()} />}</Match>
            <Match when={card.kind === 'earlier' && card}>
              {(c) => <EarlierCard card={c()} />}
            </Match>
            <Match when={card.kind === 'summary' && card}>
              {(c) => (
                <SummaryCard
                  card={c()}
                  nodes={nodes()}
                  selected={props.focused && selectedRow() === 'card:summary'}
                  rowRef={rowRef}
                />
              )}
            </Match>
          </Switch>
        )}
      </For>
    </scrollbox>
  );
}
