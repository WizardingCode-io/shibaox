import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { useTerminalDimensions } from '@opentui/solid';
import { loadOrg, OrgLoadError } from '@shibaox/schemas';
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  type JSX,
  on,
  Show,
} from 'solid-js';
import { HelpDialog } from '../component/dialogs/help.js';
import { RunsDialog } from '../component/dialogs/runs.js';
import { KeyHints } from '../component/footer.js';
import { Logo } from '../component/logo.js';
import { Prompt, type PromptRef } from '../component/prompt/index.js';
import { useClient } from '../context/client.js';
import { useConfig } from '../context/config.js';
import { useData } from '../context/data.js';
import { usePrefs } from '../context/prefs.js';
import { useRoute } from '../context/route.js';
import { money } from '../model/format.js';
import {
  ADAPTERS,
  type Adapter,
  applyPromptCommand,
  COMMAND_HINT,
  type PromptCommand,
  type PromptContext,
  toSubmitRequest,
} from '../model/prompt-commands.js';
import { useTheme } from '../theme/context.js';
import { useDialog } from '../ui/dialog.js';
import { useToast } from '../ui/toast.js';

export const PLACEHOLDERS = [
  'Ask the team anything… "Add a /health endpoint"',
  'Ask the team anything… "Fix the failing tests"',
  'Ask the team anything… "What does this repo do?"',
];
export const HOME_HINTS = [
  { key: '/', label: 'commands' },
  { key: 'ctrl+o', label: 'runs' },
  { key: 'ctrl+k', label: 'palette' },
  { key: '?', label: 'help' },
];

interface OrgInfo {
  workflows: string[];
  /** Workflows marked `conversation: true` (the org's `chat`): they run in place. */
  single: string[];
  subscription: boolean;
  error?: string;
}

/** The org's workflows and whether its strong tier runs on a subscription runtime, or why it could not be loaded. */
function orgInfo(root: string): OrgInfo {
  try {
    const org = loadOrg(root);
    const strong = String(org.models.tiers?.strong ?? '');
    return {
      workflows: Object.keys(org.workflows),
      single: Object.values(org.workflows)
        .filter((w) => w.conversation)
        .map((w) => w.workflow),
      subscription: /-subscription\//.test(strong),
    };
  } catch (e) {
    if (e instanceof OrgLoadError && /not found/i.test(e.message))
      return { workflows: [], single: [], subscription: false, error: `Org not found: ${root}` };
    return {
      workflows: [],
      single: [],
      subscription: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * The project the dashboard works on: the current directory, except the home directory itself,
 * where the orchestrator gets a workspace of its own (`~/.shibaox/workspace`).
 */
export function defaultProject(cwd: string, home: string | undefined): string {
  const h = home || homedir();
  return h && resolve(cwd) === resolve(h) ? join(h, '.shibaox', 'workspace') : cwd;
}

/** `daemon 0.0.1 · 2 running · 1 queued · ▲ 1 needs you`, or the unreachable notice. */
export function daemonLine(d: ReturnType<typeof useData>['state'], version: string): string {
  if (!d.reachable) return 'Daemon unreachable';
  const running = d.runs.filter((r) => r.status === 'running').length;
  const queued = d.runs.filter((r) => r.status === 'queued').length;
  const needs = d.inbox.length;
  return `daemon ${version} · ${running} running · ${queued} queued${needs ? ` · ▲ ${needs} needs you` : ''}`;
}

export const MOCK_NOTICE =
  'mock runs no model: the nodes complete at once. /adapter claude-code uses your Claude login';

/** `~/dir` for paths under the home directory. */
export function tilde(p: string, home: string | undefined = process.env.HOME): string {
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function Home(): JSX.Element {
  const theme = useTheme();
  const config = useConfig();
  const client = useClient();
  const data = useData();
  const prefs = usePrefs();
  const route = useRoute();
  const toast = useToast();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  let prompt: PromptRef | undefined;
  const [ctx, setCtx] = createSignal<PromptContext>({
    org: prefs.data.lastOrg ?? join(config.cwd, 'org'),
    project: defaultProject(config.cwd, config.env.HOME),
    // the org's models decide the runtime: a subscription tier runs through claude-code, an API
    // or local tier through our own agent loop (direct); mock is never the remembered choice
    adapter: ADAPTERS.find((a) => a === prefs.data.lastAdapter && a !== 'mock') ?? 'direct',
  });
  const orgRoot = createMemo(() => ctx().org);
  const org = createMemo(() => orgInfo(orgRoot()));
  // what the project is (stack, tests, size), from the daemon; nothing when it cannot say
  const [profile] = createResource(
    () => ({ project: ctx().project, org: orgRoot() }),
    (k) => client.projectProfile(k.project, k.org).catch(() => undefined),
  );
  createEffect(() => {
    if (prefs.data.lastAdapter && prefs.data.lastAdapter !== 'mock') return;
    const adapter = org().subscription ? 'claude-code' : 'direct';
    setCtx((c) => (c.adapter === adapter ? c : { ...c, adapter }));
  });
  // a closed dialog gives the keyboard back to the prompt
  createEffect(
    on(
      dialog.depth,
      (d) => {
        if (d === 0) setTimeout(() => prompt?.focus(), 0);
      },
      { defer: true },
    ),
  );
  const [error, setError] = createSignal<string | undefined>();
  const [hint, setHint] = createSignal<string | undefined>();
  // the first workflow of the org when none was picked yet
  // chat is the entry of the dashboard when the org has it; other workflows are one `/workflow` away
  const workflow = () =>
    ctx().workflow ?? (org().workflows.includes('chat') ? 'chat' : org().workflows[0]);

  const onCommand = (cmd: PromptCommand) => {
    setError(undefined);
    setHint(undefined);
    if (cmd.command === 'help') return dialog.open(() => <HelpDialog />);
    if (cmd.command === 'runs') return dialog.open(() => <RunsDialog />);
    const next = applyPromptCommand(ctx(), cmd, { cwd: config.cwd });
    if ('error' in next) return setError(next.error);
    setCtx(next);
  };
  const onSubmit = async (text: string) => {
    setError(undefined);
    setHint(undefined);
    if (org().error) return setError(org().error);
    const wf = workflow();
    if (!wf) return setError('Pick a workflow first: /workflow <name>');
    const req = toSubmitRequest({ ...ctx(), workflow: wf }, text);
    // a conversation acts on the checkout itself; teams get the org default (a worktree)
    if (req.workspace === undefined && org().single.includes(wf)) req.workspace = 'inplace';
    if (req.project === join(config.env.HOME || homedir(), '.shibaox', 'workspace'))
      mkdirSync(req.project, { recursive: true });
    const runId = await data.actions.submit(req);
    if (!runId) return;
    prefs.update({
      lastOrg: req.orgRoot,
      lastAdapter: req.adapter === 'mock' ? undefined : (req.adapter as Adapter),
      lastWorkflow: wf,
    });
    prompt?.clear();
    data.openRun(runId);
    route.navigate({ type: 'session', runId });
  };

  const notice = () => error() ?? org().error;
  const mockNotice = () => (ctx().adapter === 'mock' ? MOCK_NOTICE : undefined);
  void toast;
  const contextFooter = () => {
    const c = ctx();
    const muted = theme.text.muted;
    const accent = theme.text.action.primary.selected;
    return (
      <text fg={theme.text.base} wrapMode="none">
        <span style={{ fg: muted }}>workflow </span>
        <span style={{ fg: accent }}>{workflow() ?? '—'}</span>
        <span style={{ fg: muted }}> adapter </span>
        {c.adapter}
        <span style={{ fg: muted }}> project </span>
        {tilde(c.project, config.env.HOME)}
        {c.workspace ? <span style={{ fg: muted }}>{`   workspace ${c.workspace}`}</span> : ''}
        {c.budgetUsd !== undefined ? (
          <span style={{ fg: muted }}>{`   budget ${money(c.budgetUsd)}`}</span>
        ) : (
          ''
        )}
      </text>
    );
  };

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box
        flexGrow={1}
        alignItems="center"
        paddingLeft={dimensions().width < 44 ? 1 : 2}
        paddingRight={dimensions().width < 44 ? 1 : 2}
      >
        <box flexGrow={1} minHeight={0} />
        <Logo />
        <box height={1} flexShrink={0} />
        <box width="100%" maxWidth={76} flexShrink={0} flexDirection="column">
          <Prompt
            ref={(r) => {
              prompt = r;
            }}
            placeholders={PLACEHOLDERS}
            workflows={org().workflows}
            onSubmit={(t) => void onSubmit(t)}
            onCommand={onCommand}
            onInput={() => {
              setError(undefined);
              setHint(undefined);
            }}
            onNeedValue={(c) => setHint(COMMAND_HINT[c])}
            footer={contextFooter()}
          />
          <Show when={profile()?.summary}>
            <box height={1} flexShrink={0} width="100%" paddingLeft={1}>
              <text fg={theme.text.muted} wrapMode="none">
                {profile()?.summary ?? ''}
              </text>
            </box>
          </Show>
          <box height={1} flexShrink={0} flexDirection="row" width="100%" paddingLeft={1}>
            <Show when={notice() ?? hint() ?? mockNotice()}>
              <text
                fg={
                  notice()
                    ? theme.text.feedback.error
                    : hint()
                      ? theme.text.muted
                      : theme.text.feedback.warning
                }
                wrapMode="none"
              >
                {notice() ?? hint() ?? mockNotice() ?? ''}
              </text>
            </Show>
            <box flexGrow={1} />
            <KeyHints hints={HOME_HINTS} />
          </box>
        </box>
        <box flexGrow={1} minHeight={0} />
      </box>
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        paddingLeft={2}
        paddingRight={2}
        width="100%"
      >
        <text fg={theme.text.muted} flexShrink={1} wrapMode="none">
          {tilde(config.cwd, config.env.HOME)}
        </text>
        <text fg={theme.text.muted} flexShrink={0} wrapMode="none">
          {`  ·  ${daemonLine(data.state, config.version)}`}
        </text>
        <box flexGrow={1} flexShrink={0} width={2} />
        <text fg={theme.text.muted} flexShrink={0} wrapMode="none">
          {`shibaox ${config.version}`}
        </text>
      </box>
    </box>
  );
}
