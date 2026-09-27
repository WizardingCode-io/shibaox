import type { Renderable, ScrollBoxRenderable } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  getOwner,
  type JSX,
  Match,
  on,
  onCleanup,
  runWithOwner,
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
import { RequestBlock } from './request.js';

/** How many cards the screen mounts per run (the model keeps up to 5000). */
export const RENDER_LIMIT = 300;

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

export interface TimelineApi {
  scrollBy(lines: number): void;
}

/**
 * The conversation of a tab: every run of its thread (request block, then cards), in a
 * scrollbox that follows the newest content until the user scrolls up, with a cursor over card
 * headers and tool lines (enter expands or collapses).
 */
export function Timeline(props: {
  runId: string;
  focused: boolean;
  onToggle?: (id: string) => void;
  api?: (api: TimelineApi) => void;
}): JSX.Element {
  const data = useData();
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const runs = createMemo(() => data.threadOf(props.runId));
  const owner = getOwner();
  const memos = new Map<string, Accessor<Card[]>>();
  // per-run memos live under the timeline itself, never under whichever computation asks first
  const cardsOf = (run: string): Accessor<Card[]> => {
    let m = memos.get(run);
    if (!m) {
      const all = data.timeline(run);
      // only the newest cards are mounted: every card costs native renderables (spinner,
      // fade-in, markdown); older ones fold into the "earlier" line
      const limited = () => {
        const list = all();
        if (list.length <= RENDER_LIMIT) return list;
        const dropped = list.slice(0, list.length - RENDER_LIMIT);
        const earlier = dropped.reduce((n, c) => n + (c.kind === 'earlier' ? c.count : 1), 0);
        return [
          { kind: 'earlier', key: 'earlier', count: earlier } as Card,
          ...list.slice(-RENDER_LIMIT),
        ];
      };
      m = runWithOwner(owner, () => createMemo(limited)) ?? limited;
      memos.set(run, m);
    }
    return m;
  };
  const rows = createMemo(() =>
    runs().flatMap((run) => selectableRows(cardsOf(run)()).map((id) => `${run}|${id}`)),
  );
  const version = createMemo(() => runs().reduce((n, run) => n + cardsOf(run)().length, 0));
  const [cursor, setCursor] = createSignal(0);
  const [expanded, setExpanded] = createSignal(new Set<string>(), { equals: false });
  const [now, setNow] = createSignal(Date.now());
  // true until the user scrolls up: the view then follows the newest content
  const [following, setFollowing] = createSignal(true);
  const refs = new Map<string, Renderable>();
  let scroll: ScrollBoxRenderable | undefined;
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));

  // OpenTUI's stickyScroll re-sticks after a programmatic scrollTo(0), so following is ours alone
  const follow = () => {
    if (!following() || !scroll) return;
    scroll.scrollTo(scroll.scrollHeight);
  };
  createEffect(
    on([version, dimensions], () => {
      setTimeout(follow, 0);
      setTimeout(follow, 120);
    }),
  );
  props.api?.({ scrollBy: (n) => scroll?.scrollBy(n) });

  const selectedRow = () => rows()[Math.min(cursor(), rows().length - 1)];
  /** The selected row id inside `run`, or undefined when the cursor is in another run. */
  const selectedIn = (run: string) => {
    const s = selectedRow();
    return props.focused && s?.startsWith(`${run}|`) ? s.slice(run.length + 1) : undefined;
  };

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
  /** The expanded set as the cards see it: ids of this run only. */
  const expandedIn = (run: string) =>
    new Set(
      [...expanded()]
        .filter((id) => id.startsWith(`${run}|`))
        .map((id) => id.slice(run.length + 1)),
    );

  useKeys('pane', (key) => {
    if (!props.focused || key.ctrl || key.meta) return false;
    const n = rows().length;
    switch (key.name) {
      // j/k walk the cursor; the arrows (and a wheel the terminal turns into arrows) scroll the view
      case 'j':
        if (cursor() < n - 1) move(1);
        else scroll?.scrollBy(1);
        return true;
      case 'k':
        setFollowing(false);
        if (cursor() > 0) move(-1);
        else scroll?.scrollBy(-1);
        return true;
      case 'down':
        scroll?.scrollBy(2);
        return true;
      case 'up':
        setFollowing(false);
        scroll?.scrollBy(-2);
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

  const rowRefFor = (run: string) => (id: string, el: unknown) => {
    const key = `${run}|${id}`;
    if (el) refs.set(key, el as Renderable);
    else refs.delete(key);
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
      contentOptions={{ flexDirection: 'column', paddingTop: 1, paddingLeft: 2, paddingRight: 2 }}
    >
      <For each={runs()}>
        {(run) => {
          const cards = cardsOf(run);
          const rowRef = rowRefFor(run);
          const selected = createMemo(() => selectedIn(run));
          const expandedHere = createMemo(() => expandedIn(run));
          const nodes = createMemo(
            () =>
              cards().filter(
                (c) => c.kind !== 'error' && c.kind !== 'earlier' && c.kind !== 'summary',
              ).length,
          );
          return (
            <>
              <RequestBlock runId={run} />
              <For each={cards()}>
                {(card) => (
                  <Switch>
                    <Match when={card.kind === 'node' && card}>
                      {(c) => (
                        <NodeCard
                          card={c()}
                          now={now()}
                          selectedRow={selected()}
                          expanded={expandedHere()}
                          rowRef={rowRef}
                        />
                      )}
                    </Match>
                    <Match when={card.kind === 'gate' && card}>
                      {(c) => (
                        <GateCard
                          card={c()}
                          selected={selected() === `card:${c().nodeId}`}
                          rowRef={rowRef}
                        />
                      )}
                    </Match>
                    <Match when={card.kind === 'decide' && card}>
                      {(c) => (
                        <DecideCard
                          card={c()}
                          selected={selected() === `card:${c().nodeId}`}
                          rowRef={rowRef}
                        />
                      )}
                    </Match>
                    <Match when={card.kind === 'human' && card}>
                      {(c) => (
                        <HumanCard
                          card={c()}
                          selected={selected() === `card:${c().nodeId}`}
                          rowRef={rowRef}
                        />
                      )}
                    </Match>
                    <Match when={card.kind === 'error' && card}>
                      {(c) => <ErrorCard card={c()} />}
                    </Match>
                    <Match when={card.kind === 'earlier' && card}>
                      {(c) => <EarlierCard card={c()} />}
                    </Match>
                    <Match when={card.kind === 'summary' && card}>
                      {(c) => (
                        <SummaryCard
                          card={c()}
                          nodes={nodes()}
                          selected={selected() === 'card:summary'}
                          rowRef={rowRef}
                        />
                      )}
                    </Match>
                  </Switch>
                )}
              </For>
            </>
          );
        }}
      </For>
    </scrollbox>
  );
}
