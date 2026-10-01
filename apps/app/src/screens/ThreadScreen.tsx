import type { InboxItem } from '@wizardingcode/shibaox-daemon';
import {
  type Block,
  type Card,
  type MessagePart,
  money,
  summarizeInput,
  type ThreadMessage,
} from '@wizardingcode/shibaox-view';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunFileContent } from '../api/client.js';
import { addFiles, dragHasFiles, encodeFiles } from '../attachments.js';
import { desktopBridge } from '../desktop.js';
import { ds } from '../ds.js';
import { clock, duration, RUN_STATUS_TONE, RUN_STATUS_WORD, shortModel } from '../format.js';
import { useFollowScroll } from '../hooks/follow-scroll.js';
import { highlight } from '../markdown/highlight.js';
import { type CodeOpen, Markdown } from '../markdown/render.js';
import { navigate } from '../router.js';
import { useAppState, useStore } from '../store/hooks.js';
import { FileSheet, type InlineFile, type SaveTarget } from './FileSheet.js';

const TOOL_ICON: Record<string, string> = {
  browser: 'globe',
  web_fetch: 'globe',
  run_command: 'terminal',
  read_file: 'file-text',
  write_file: 'file-text',
  list_files: 'folder',
  mcp: 'plug',
};
type IconName = Parameters<Window['Shibaox']['Icon']>[0]['name'];
const iconFor = (name: string): IconName =>
  (TOOL_ICON[name] ??
    TOOL_ICON[name.split(/[._]/)[0] ?? ''] ??
    (name.startsWith('mcp__') ? 'plug' : 'zap')) as IconName;

/** `finish` is how a task hands back its result: the reply already shows it, so the call itself stays in Logs. */
const INTERNAL_TOOLS = new Set(['finish']);

/** A tool call as the mockup's ToolCall: its output as a code block, clipped when long. */
function ToolBlock(props: { block: Extract<Block, { kind: 'tool' }> }): JSX.Element {
  const S = ds();
  const b = props.block;
  const output =
    b.output === undefined
      ? undefined
      : typeof b.output === 'string'
        ? b.output
        : JSON.stringify(b.output, null, 2);
  const shown =
    output === undefined
      ? ''
      : output.length > 20000
        ? `${output.slice(0, 20000)}\n… (${output.length} characters)`
        : output;
  return (
    <S.ToolCall
      tool={b.name}
      summary={b.summary || summarizeInput(b.input)}
      status={b.status}
      icon={iconFor(b.name)}
      duration={duration(b.ms)}
      args={b.input as Record<string, unknown>}
      defaultOpen={b.status === 'error'}
    >
      {output !== undefined ? (
        <S.CodeBlock
          language={typeof b.output === 'string' ? 'text' : 'json'}
          code={shown}
          wrap
          maxHeight={240}
        >
          {typeof b.output === 'string' ? shown : highlight(shown, 'json')}
        </S.CodeBlock>
      ) : undefined}
    </S.ToolCall>
  );
}

/** The agent's turn as it happened: text as a document, tool calls and files in between. */
/** A file of the run referred to as an image in the reply: shown inline once loaded. */
function RunImage(props: {
  runId: string;
  path: string;
  alt: string;
  load: (runId: string, path: string) => Promise<RunFileContent>;
  onOpen: () => void;
}): JSX.Element {
  const [src, setSrc] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    props
      .load(props.runId, props.path)
      .then((f) => {
        if (live && f.encoding === 'base64' && f.mime?.startsWith('image/') && !f.truncated)
          setSrc(`data:${f.mime};base64,${f.content}`);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [props.load, props.runId, props.path]);
  if (!src) return <span className="muted">{props.alt || props.path}</span>;
  return (
    <button type="button" className="inline-image" onClick={props.onOpen} title={props.path}>
      <img src={src} alt={props.alt || props.path} />
    </button>
  );
}

function Parts(props: {
  parts: MessagePart[];
  onFile: (path: string) => void;
  onOpenCode: (code: CodeOpen) => void;
  /** Renders a Markdown image whose path is a file of the run. */
  renderImage?: (path: string, alt: string) => ReactNode;
  /** The turn is still streaming: its last text part is treated as unfinished. */
  pending?: boolean;
  /** The run's workspace: absolute paths it reported are shown relative to it. */
  workspace?: string;
}): JSX.Element {
  const S = ds();
  return (
    <>
      {props.parts
        .filter((p) => !(p.kind === 'tool' && INTERNAL_TOOLS.has(p.name)))
        .map((p, i, all) =>
          p.kind === 'text' ? (
            <Markdown
              key={p.key}
              text={p.text}
              pending={props.pending && i === all.length - 1}
              onOpenCode={props.onOpenCode}
              renderImage={props.renderImage}
            />
          ) : p.kind === 'tool' ? (
            <ToolBlock key={p.key} block={p} />
          ) : (
            <div key={p.key}>
              <S.FileChip
                path={workspacePath(p.path, props.workspace)}
                status="added"
                onClick={() => props.onFile(workspacePath(p.path, props.workspace))}
              />
            </div>
          ),
        )}
    </>
  );
}

/** A path as the run reported it, relative to its workspace when it was absolute. */
export function workspacePath(path: string, workspace: string | undefined): string {
  if (!workspace || !path.startsWith(workspace)) return path;
  const rel = path.slice(workspace.length).replace(/^[\\/]+/, '');
  return rel || path;
}

/** Every file the conversation produced (the latest run that touched each): the Outputs row. */
function outputsOf(
  messages: ThreadMessage[],
  workspaceOf: (runId: string) => string | undefined,
): { runId: string; path: string }[] {
  const latest = new Map<string, string>();
  for (const m of messages)
    for (const p of m.parts)
      if (p.kind === 'file') latest.set(workspacePath(p.path, workspaceOf(m.runId)), m.runId);
  return [...latest.entries()].map(([path, runId]) => ({ runId, path }));
}

/** A pending approval of a command or a file write, as the mockup's ToolCall with Approve/Deny. */
function ApprovalCall(props: { item: InboxItem }): JSX.Element {
  const S = ds();
  const store = useStore();
  const d = props.item.detail;
  return (
    <S.ToolCall
      tool={d.tool === 'file' ? 'write' : (d.program ?? 'command')}
      summary={props.item.prompt}
      status="approval"
      icon={d.tool === 'file' ? 'file-text' : 'terminal'}
      defaultOpen
      onApprove={() => void store.answer(props.item.id, true)}
      onDeny={() => void store.answer(props.item.id, false)}
    >
      <div className="muted">
        {d.category ? `${d.category} · ` : ''}
        {d.role ? `role ${d.role}` : ''}
      </div>
    </S.ToolCall>
  );
}

/** A human node waiting for you: the prompt, a note, Approve and Deny. */
function HumanAsk(props: { item: InboxItem }): JSX.Element {
  const S = ds();
  const store = useStore();
  const [note, setNote] = useState('');
  return (
    <S.Message from="agent" name="Shibaox">
      <p style={{ margin: 0 }}>{props.item.prompt}</p>
      <div className="row" style={{ marginTop: 8 }}>
        <S.Input
          placeholder="A note (optional)"
          value={note}
          onChange={(e) => setNote((e.target as HTMLInputElement).value)}
        />
        <S.Button
          variant="primary"
          onClick={() => void store.answer(props.item.id, true, note || undefined)}
        >
          Approve
        </S.Button>
        <S.Button
          variant="danger"
          onClick={() => void store.answer(props.item.id, false, note || undefined)}
        >
          Deny
        </S.Button>
      </div>
    </S.Message>
  );
}

function ChatTab(props: {
  rootId: string;
  messages: ThreadMessage[];
  inbox: InboxItem[];
  onFile: (runId: string, path: string) => void;
  onOpenCode: (code: CodeOpen) => void;
  loadFile: (runId: string, path: string) => Promise<RunFileContent>;
  /** The run still streaming, if any. */
  live?: string;
}): JSX.Element {
  const S = ds();
  const state = useAppState();
  const scroll = useRef<HTMLDivElement>(null);
  // grows with every delta and tool call of the newest turn: what the view follows
  const version = props.messages.reduce((n, m) => n + m.text.length + m.blocks.length * 997, 0);
  const follow = useFollowScroll(scroll, version + props.inbox.length);
  const byRun = (runId: string) => props.inbox.filter((i) => i.runId === runId);
  // what a dispatched run asks for belongs to the conversation too: it follows the last message
  const turnRuns = new Set(props.messages.map((m) => m.runId));
  const fromTasks = props.inbox.filter((i) => !turnRuns.has(i.runId));
  return (
    <div className="scroll sx-scroll" ref={scroll}>
      <div className="thread">
        {props.messages.map((m) =>
          m.from === 'user' ? (
            <S.Message key={m.key} from="user">
              {m.text ? <Markdown text={m.text} plain /> : null}
              {m.attachments?.length ? (
                <div className="row" style={{ flexWrap: 'wrap', marginTop: m.text ? 6 : 0 }}>
                  {m.attachments.map((a) => (
                    <S.FileChip
                      key={a.path}
                      path={a.path}
                      status="added"
                      onClick={() => props.onFile(m.runId, a.path)}
                    />
                  ))}
                </div>
              ) : null}
            </S.Message>
          ) : (
            <div key={m.key} className="stack">
              {(m.text || m.blocks.length > 0) && (
                <S.Message
                  from="agent"
                  name="Shibaox"
                  time={m.pending ? undefined : clock(m.time)}
                  model={shortModel(m.model)}
                  mood={m.pending ? 'working' : 'default'}
                >
                  <Parts
                    parts={m.parts}
                    pending={m.pending || props.live === m.runId}
                    workspace={state.states[m.runId]?.workspace}
                    onFile={(path) => props.onFile(m.runId, path)}
                    onOpenCode={props.onOpenCode}
                    renderImage={(path, alt) => (
                      <RunImage
                        runId={m.runId}
                        path={path}
                        alt={alt}
                        load={props.loadFile}
                        onOpen={() => props.onFile(m.runId, path)}
                      />
                    )}
                  />
                </S.Message>
              )}
              {byRun(m.runId).map((i) =>
                i.kind === 'approval' ? (
                  <ApprovalCall key={i.id} item={i} />
                ) : (
                  <HumanAsk key={i.id} item={i} />
                ),
              )}
              {m.pending && byRun(m.runId).length === 0 ? <S.ThinkingIndicator /> : null}
              {byRun(m.runId).length > 0 ? (
                <S.ThinkingIndicator label="Waiting for your approval" />
              ) : null}
            </div>
          ),
        )}
        {fromTasks.length > 0 ? (
          <div className="stack">
            {fromTasks.map((i) =>
              i.kind === 'approval' ? (
                <ApprovalCall key={i.id} item={i} />
              ) : (
                <HumanAsk key={i.id} item={i} />
              ),
            )}
            <S.ThinkingIndicator label="Waiting for your approval" />
          </div>
        ) : null}
        {props.messages.length === 0 ? (
          <div className="empty">
            <h2>Nothing here yet</h2>
            <p>Ask Shibaox to do something below.</p>
          </div>
        ) : null}
        {follow.behind ? (
          <S.Button
            className="jump"
            size="sm"
            variant="secondary"
            icon="chevron-down"
            onClick={follow.jump}
          >
            Jump to latest
          </S.Button>
        ) : null}
      </div>
    </div>
  );
}

/** A note for a running task (a turn or a dispatched run): it stops and starts again with it. */
function SteerForm(props: { runId: string; onDone: () => void }): JSX.Element {
  const S = ds();
  const store = useStore();
  const [note, setNote] = useState('');
  return (
    <form
      className="steer"
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim()) void store.steer(props.runId, note.trim());
        props.onDone();
      }}
    >
      <S.Input
        placeholder="A note for the running task"
        value={note}
        onChange={(e) => setNote((e.target as HTMLInputElement).value)}
      />
      <S.Button size="sm" variant="primary" type="submit">
        Send note
      </S.Button>
    </form>
  );
}

/** A paused run (budget spent): a budget and Resume. */
function ResumeForm(props: { runId: string }): JSX.Element {
  const S = ds();
  const store = useStore();
  const [budget, setBudget] = useState('');
  return (
    <form
      className="steer"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number.parseFloat(budget);
        void store.resume(props.runId, Number.isFinite(n) && n > 0 ? n : undefined);
      }}
    >
      <S.Input
        placeholder="Budget (USD)"
        value={budget}
        onChange={(e) => setBudget((e.target as HTMLInputElement).value)}
      />
      <S.Button size="sm" variant="primary" type="submit">
        Resume
      </S.Button>
    </form>
  );
}

/** Steer in the top bar: an icon button; the note floats below it, never inside the bar. */
function SteerPopover(props: { runId: string }): JSX.Element {
  const S = ds();
  const [open, setOpen] = useState(false);
  return (
    <S.Popover
      open={open}
      onClose={() => setOpen(false)}
      align="end"
      label="Steer the running task"
      anchor={
        <S.IconButton
          icon="send-horizontal"
          label="Steer"
          size="sm"
          onClick={() => setOpen((o) => !o)}
        />
      }
    >
      <SteerForm runId={props.runId} onDone={() => setOpen(false)} />
    </S.Popover>
  );
}

/** Resume in the top bar, the same way: an icon button and a floating budget form. */
function ResumePopover(props: { runId: string }): JSX.Element {
  const S = ds();
  const [open, setOpen] = useState(false);
  return (
    <S.Popover
      open={open}
      onClose={() => setOpen(false)}
      align="end"
      label="Resume the paused run"
      anchor={
        <S.IconButton
          icon="play"
          label="Resume with a budget"
          size="sm"
          onClick={() => setOpen((o) => !o)}
        />
      }
    >
      <ResumeForm runId={props.runId} />
    </S.Popover>
  );
}

function TasksTab(props: { rootId: string; inbox: InboxItem[] }): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const tasks = store.tasksOf(props.rootId);
  const [steering, setSteering] = useState<string | undefined>(undefined);
  return (
    <div className="page sx-scroll">
      {tasks.length === 0 ? (
        <p className="muted">No runs were dispatched in this conversation yet.</p>
      ) : null}
      {tasks.map((t) => {
        const st = state.states[t.runId];
        const live = !['completed', 'failed', 'cancelled'].includes(t.status);
        const asks = props.inbox.filter((i) => i.runId === t.runId);
        return (
          <S.Card
            key={t.runId}
            icon="zap"
            title={t.workflow}
            description={st ? (st.error ?? `${Object.keys(st.nodes).length} nodes`) : undefined}
            action={
              <S.Badge tone={RUN_STATUS_TONE[t.status] ?? 'neutral'}>
                {RUN_STATUS_WORD[t.status] ?? t.status}
              </S.Badge>
            }
            footer={
              <div className="stack">
                {asks.map((i) =>
                  i.kind === 'approval' ? (
                    <ApprovalCall key={i.id} item={i} />
                  ) : (
                    <HumanAsk key={i.id} item={i} />
                  ),
                )}
                {t.status === 'paused_budget' ? <ResumeForm runId={t.runId} /> : null}
                {steering === t.runId ? (
                  <SteerForm runId={t.runId} onDone={() => setSteering(undefined)} />
                ) : null}
                <div className="row">
                  <span className="muted">{money(t.spentUsd)}</span>
                  <span className="grow" />
                  <S.Button
                    size="sm"
                    onClick={() => navigate(`#/t/${encodeURIComponent(t.runId)}`)}
                  >
                    Open
                  </S.Button>
                  {t.status === 'running' ? (
                    <S.Button size="sm" onClick={() => setSteering(t.runId)}>
                      Steer
                    </S.Button>
                  ) : null}
                  {live ? (
                    <S.Button size="sm" variant="danger" onClick={() => void store.cancel(t.runId)}>
                      Cancel
                    </S.Button>
                  ) : null}
                </div>
              </div>
            }
          />
        );
      })}
    </div>
  );
}

function LogsTab(props: { rootId: string }): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const turns = store.turnsOf(props.rootId);
  const cards: { runId: string; card: Card }[] = turns.flatMap((t) =>
    (state.cards[t.runId] ?? []).map((card) => ({ runId: t.runId, card })),
  );
  const line = (
    c: Card,
  ): {
    title: string;
    description?: string;
    tone: 'neutral' | 'matcha' | 'info' | 'warning' | 'danger';
    word: string;
  } => {
    switch (c.kind) {
      case 'node':
        return {
          title: `${c.nodeId}${c.role ? ` · ${c.role}` : ''}`,
          description: `${c.tools} tool call${c.tools === 1 ? '' : 's'}${c.costUsd !== undefined ? ` · ${money(c.costUsd)}` : ''}`,
          tone: c.status === 'failed' ? 'danger' : c.status === 'completed' ? 'matcha' : 'info',
          word: c.status,
        };
      case 'gate':
        return {
          title: `gate ${c.nodeId}`,
          description: c.checks
            .map((k) => `${k.name}: ${k.passed ? 'passed' : 'failed'}`)
            .join(' · '),
          tone: c.passed === false ? 'danger' : c.passed ? 'matcha' : 'info',
          word: c.passed === undefined ? c.status : c.passed ? 'passed' : 'failed',
        };
      case 'decide':
        return {
          title: `Decision · ${c.nodeId}`,
          description: c.choice
            ? `${c.choice}${c.confidence !== undefined ? ` · ${Math.round(c.confidence * 100)}% sure` : ''}${c.by ? ` · by ${c.by}` : ''}`
            : undefined,
          tone: 'info',
          word: c.status,
        };
      case 'human':
        return {
          title: c.prompt,
          description: c.answer
            ? `${c.answer.approved ? 'approved' : 'denied'}${c.answer.via ? ` via ${c.answer.via}` : ''}`
            : undefined,
          tone: c.pending ? 'warning' : 'matcha',
          word: c.pending ? 'waiting' : 'answered',
        };
      case 'error':
        return { title: c.message, tone: 'danger', word: 'error' };
      case 'summary':
        return {
          title: `run ${c.status}`,
          description: `${money(c.costUsd)}${c.files.length ? ` · ${c.files.length} files` : ''}${c.branch ? ` · ${c.branch}` : ''}`,
          tone: c.status === 'completed' ? 'matcha' : c.status === 'failed' ? 'danger' : 'neutral',
          word: c.status,
        };
      case 'earlier':
        return { title: `${c.count} earlier events`, tone: 'neutral', word: '' };
    }
  };
  return (
    <div className="page sx-scroll">
      <div className="row">
        <span className="muted">Every node, gate, decision and approval of this conversation.</span>
        <span className="grow" />
        <S.Button
          size="sm"
          icon="file-text"
          onClick={() =>
            void store
              .audit(turns[turns.length - 1]?.runId ?? props.rootId)
              .then((md) =>
                window.open(
                  URL.createObjectURL(new Blob([md], { type: 'text/markdown' })),
                  '_blank',
                ),
              )
              .catch(() => undefined)
          }
        >
          Open audit
        </S.Button>
      </div>
      {cards.map(({ runId, card }) => {
        const l = line(card);
        return (
          <S.Card
            key={`${runId}:${card.key}`}
            title={l.title}
            description={l.description}
            action={l.word ? <S.Badge tone={l.tone}>{l.word}</S.Badge> : undefined}
          />
        );
      })}
    </div>
  );
}

/** The bolt's menu: the org's workflows to start here, Higgsfield prefills, and the file picker. */
function useActionsMenu(
  open: boolean,
  close: () => void,
  on: {
    onWorkflow: (name: string) => void;
    onPrefill: (text: string) => void;
    onAttach: () => void;
  },
): ReactNode {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  useEffect(() => {
    if (open && !state.skills) void store.loadSkills();
  }, [open, state.skills, store]);
  if (!open) return undefined;
  const workflows = (state.skills?.workflows ?? []).filter((w) => !w.conversation);
  const items = [
    { id: 'image', label: 'Generate an image…', hint: 'Higgsfield', icon: 'image' as const },
    { id: 'video', label: 'Generate a video…', hint: 'Higgsfield', icon: 'image' as const },
    {
      id: 'attach',
      label: 'Attach files…',
      hint: 'or drop them on the conversation',
      icon: 'plus' as const,
    },
    ...(workflows.length > 0 ? [{ id: '-', label: '' }] : []),
    ...workflows.map((w) => ({
      id: `wf:${w.name}`,
      label: `Run ${w.name}`,
      hint: w.description || 'a workflow of the org, started in this conversation',
      icon: 'zap' as const,
    })),
  ];
  return (
    <S.MenuList
      title="Actions"
      items={items}
      onSelect={(id) => {
        if (id === 'image') on.onPrefill('Generate an image of ');
        else if (id === 'video') on.onPrefill('Generate a short video of ');
        else if (id === 'attach') on.onAttach();
        else if (id.startsWith('wf:')) on.onWorkflow(id.slice(3));
      }}
      onClose={close}
    />
  );
}

type Recognizer = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult:
    | ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};

/** The browser's speech recognition when it exists (Chrome): words land in the composer. */
function useVoice(
  onWords: (words: string) => void,
  onError: (reason: string) => void,
): {
  available: boolean;
  listening: boolean;
  toggle: () => void;
} {
  const w = globalThis as {
    SpeechRecognition?: new () => Recognizer;
    webkitSpeechRecognition?: new () => Recognizer;
  };
  // Electron defines the API but has no speech service behind it: no mic in the desktop app
  const Ctor = desktopBridge() ? undefined : (w.SpeechRecognition ?? w.webkitSpeechRecognition);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognizer | undefined>(undefined);
  useEffect(
    () => () => {
      rec.current?.stop();
      rec.current = undefined;
    },
    [],
  );
  const toggle = useCallback(() => {
    if (!Ctor) return;
    if (rec.current) {
      rec.current.stop();
      rec.current = undefined;
      setListening(false);
      return;
    }
    const r = new Ctor();
    r.lang = navigator.language || 'en';
    r.interimResults = false;
    r.continuous = true;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i]?.[0]?.transcript?.trim();
        if (t) onWords(t);
      }
    };
    r.onend = () => {
      rec.current = undefined;
      setListening(false);
    };
    r.onerror = () => {
      rec.current = undefined;
      setListening(false);
      onError('The microphone could not listen here (no speech service, or no permission).');
    };
    rec.current = r;
    r.start();
    setListening(true);
  }, [Ctor, onWords, onError]);
  return { available: Boolean(Ctor), listening, toggle };
}

/**
 * The model of the next turns, chosen from the composer's label (as the mockup places it):
 * the org's tiers, or one of the configured models.
 */
function useModelMenu(
  rootId: string,
  current: string | undefined,
  open: boolean,
  close: () => void,
) {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  useEffect(() => {
    if (open && !state.integrations) void store.loadIntegrations();
  }, [open, state.integrations, store]);
  if (!open) return undefined;
  const models = (state.integrations?.models ?? []).filter((m) => m.configured || m.available);
  const items = [
    {
      id: '',
      label: "The org's tiers",
      hint: 'strong for tasks, cheap for summaries',
      checked: !current,
    },
    ...models.map((m) => ({
      id: m.ref,
      label: shortModel(m.ref) ?? m.ref,
      hint: `${m.provider}${m.local ? ' · local' : ''}`,
      checked: current === m.ref,
    })),
  ];
  return (
    <S.MenuList
      title="Model for this conversation"
      search={items.length > 3 ? 'Search models…' : undefined}
      items={items}
      onSelect={(id) => store.setThreadModel(rootId, id || undefined)}
      onClose={close}
    />
  );
}

/** The mockup's main column for one conversation: top bar, tabs, thread, composer. */
export function ThreadScreen(props: { rootId: string }): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const [tab, setTab] = useState<'chat' | 'tasks' | 'logs'>('chat');
  const [modelOpen, setModelOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dropping, setDropping] = useState(false);
  // a workflow picked in the actions menu: the next message starts it in this conversation
  const [pendingWorkflow, setPendingWorkflow] = useState<string | undefined>(undefined);
  const onWords = useCallback((words: string) => setText((t) => (t ? `${t} ${words}` : words)), []);
  const voice = useVoice(onWords, (reason) => store.notice(reason));
  const attach = useCallback(
    (picked: File[]) => {
      const r = addFiles(files, picked);
      if (r.notice) store.notice(r.notice);
      else setFiles(r.files);
    },
    [files, store],
  );
  const sendMessage = useCallback(
    async (raw: string) => {
      let message = raw.trim();
      let workflow: string | undefined;
      const prefix = pendingWorkflow ? `run ${pendingWorkflow}:` : '';
      if (pendingWorkflow && message.toLowerCase().startsWith(prefix)) {
        workflow = pendingWorkflow;
        message = message.slice(prefix.length).trim();
      }
      const attachments = await encodeFiles(files);
      // the composer is cleared only once the daemon took the message: a failure keeps it all
      const runId = await store.send(props.rootId, message, { attachments, workflow });
      if (runId === undefined) return;
      setText('');
      setFiles([]);
      setPendingWorkflow(undefined);
    },
    [files, pendingWorkflow, store, props.rootId],
  );
  const actionsMenu = useActionsMenu(actionsOpen, () => setActionsOpen(false), {
    onWorkflow: (name) => {
      setPendingWorkflow(name);
      setText(`Run ${name}: `);
    },
    onPrefill: (t) => setText(t),
    onAttach: () =>
      document.querySelector<HTMLInputElement>('.sx-composer input[type=file]')?.click(),
  });
  const [file, setFile] = useState<
    { runId: string; path: string } | { inline: InlineFile } | undefined
  >(undefined);
  // files saved from the panel in this session: listed under Outputs until the run's own list has them
  const [savedHere, setSavedHere] = useState<{ runId: string; path: string }[]>([]);
  const loadFile = useCallback(
    (runId: string, path: string) => store.loadFile(runId, path),
    [store],
  );
  useEffect(() => {
    store.openThread(props.rootId);
    return () => store.openThread(undefined);
  }, [store, props.rootId]);
  const view = store.thread(props.rootId);
  const turns = store.turnsOf(props.rootId);
  const runIds = useMemo(
    () =>
      new Set([...turns.map((t) => t.runId), ...store.tasksOf(props.rootId).map((t) => t.runId)]),
    [turns, store, props.rootId],
  );
  const inbox = state.inbox.filter((i) => runIds.has(i.runId));
  const live = store.liveTurn(props.rootId);
  const picked = state.threadModels[props.rootId];
  const currentRef =
    picked !== undefined
      ? picked || undefined
      : (state.states[turns[turns.length - 1]?.runId ?? '']?.model ?? state.settings.model);
  const model = shortModel(currentRef);
  const closeModel = useCallback(() => setModelOpen(false), []);
  const modelMenu = useModelMenu(props.rootId, currentRef, modelOpen, closeModel);
  const busy = live !== undefined || state.busy[props.rootId] === true;
  const outputs = useMemo(() => {
    const own = outputsOf(view?.messages ?? [], (id) => state.states[id]?.workspace);
    const seen = new Set(own.map((o) => o.path));
    return [...own, ...savedHere.filter((s) => !seen.has(s.path))];
  }, [view?.messages, state.states, savedHere]);
  // where a code block can be saved: the newest finished run of the conversation with a
  // workspace, and only while no turn is running (a live turn owns the checkout)
  const saveTarget = useMemo((): SaveTarget | undefined => {
    if (live !== undefined || state.busy[props.rootId]) return undefined;
    for (let i = turns.length - 1; i >= 0; i--) {
      const id = turns[i]?.runId;
      const st = id ? state.states[id] : undefined;
      if (id && st?.workspace && ['completed', 'failed', 'cancelled'].includes(st.status))
        return {
          runId: id,
          workspace: st.workspace,
          write: async (path, content) => {
            const saved = await store.writeFile(id, path, content);
            setSavedHere((s) => [...s, { runId: id, path: saved }]);
            return saved;
          },
        };
    }
    return undefined;
  }, [turns, state.states, store, live, state.busy, props.rootId]);
  // the app is served by the daemon it talks to (or the desktop's bridge to the local one):
  // a loopback origin means the workspace is on this machine
  const localDaemon = useMemo(
    () => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(location.origin),
    [],
  );
  const loadWhole = useCallback((id: string, p: string) => store.loadWhole(id, p), [store]);
  const openCode = useCallback(
    (code: CodeOpen) =>
      setFile({ inline: { name: code.name, content: code.text, lang: code.lang } }),
    [],
  );
  const runningTasks = store
    .tasksOf(props.rootId)
    .filter((t) => !['completed', 'failed', 'cancelled'].includes(t.status)).length;
  return (
    <main
      className="main"
      onDragOver={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        setDropping(false);
        attach([...e.dataTransfer.files]);
      }}
    >
      <div className="top">
        <h2>{view?.title || 'Conversation'}</h2>
        <S.AgentStatus status={inbox.length > 0 ? 'waiting' : (view?.status ?? 'idle')} />
        <span className="grow" />
        {live?.status === 'paused_budget' ? <ResumePopover runId={live.runId} /> : null}
        {live?.status === 'running' ? <SteerPopover runId={live.runId} /> : null}
        <S.Tabs
          items={[
            { id: 'chat', label: 'Chat' },
            { id: 'tasks', label: 'Tasks', count: runningTasks || undefined },
            { id: 'logs', label: 'Logs' },
          ]}
          value={tab}
          onChange={(id) => setTab(id as typeof tab)}
        />
      </div>
      {tab === 'chat' && outputs.length > 0 ? (
        <div className="outputs">
          <span className="outputs__label">Outputs · {outputs.length}</span>
          {outputs.map((o) => (
            <S.FileChip key={`${o.runId}:${o.path}`} path={o.path} onClick={() => setFile(o)} />
          ))}
        </div>
      ) : null}
      {tab === 'chat' ? (
        <ChatTab
          rootId={props.rootId}
          messages={view?.messages ?? []}
          inbox={inbox}
          live={live?.runId}
          onFile={(runId, path) => setFile({ runId, path })}
          onOpenCode={openCode}
          loadFile={loadFile}
        />
      ) : null}
      {file ? (
        <FileSheet
          key={
            'inline' in file
              ? `inline:${file.inline.name}:${file.inline.content.length}`
              : `${file.runId}:${file.path}`
          }
          {...('inline' in file ? { inline: file.inline } : { runId: file.runId, path: file.path })}
          save={saveTarget}
          loadWhole={loadWhole}
          localDaemon={localDaemon}
          saveNote={
            saveTarget ? undefined : 'Save to project comes back once the turn has finished.'
          }
          load={loadFile}
          onClose={() => setFile(undefined)}
          onDownload={(runId, path) => void store.downloadFile(runId, path)}
          onDownloadInline={(name, content) => store.downloadText(name, content)}
        />
      ) : null}
      {tab === 'tasks' ? <TasksTab rootId={props.rootId} inbox={inbox} /> : null}
      {tab === 'logs' ? <LogsTab rootId={props.rootId} /> : null}
      {tab === 'chat' ? (
        <div className="compose">
          <S.Composer
            key={props.rootId}
            model={model ?? "the org's tiers"}
            busy={busy}
            placeholder={
              pendingWorkflow
                ? `What should ${pendingWorkflow} work on?`
                : 'Ask Shibaox to do something…'
            }
            value={text}
            onChange={(t) => {
              setText(t);
              if (pendingWorkflow && !t.toLowerCase().startsWith(`run ${pendingWorkflow}:`))
                setPendingWorkflow(undefined);
            }}
            attachments={files.map((f) => ({ name: f.name, size: f.size }))}
            onAttach={attach}
            onRemoveAttachment={(i) => setFiles((f) => f.filter((_, j) => j !== i))}
            dropping={dropping}
            onSend={(t) => void sendMessage(t)}
            onStop={() => void store.stopThread(props.rootId)}
            onModelClick={() => setModelOpen((o) => !o)}
            modelMenu={modelMenu}
            onModelMenuClose={closeModel}
            onActionsClick={() => setActionsOpen((o) => !o)}
            actionsMenu={actionsMenu}
            onActionsMenuClose={() => setActionsOpen(false)}
            voice={voice.available}
            listening={voice.listening}
            onVoice={voice.available ? voice.toggle : undefined}
          />
        </div>
      ) : null}
    </main>
  );
}
