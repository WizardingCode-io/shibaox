import { existsSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { useTerminalDimensions } from '@opentui/solid';
import { loadOrg, OrgLoadError } from '@shibaox/schemas';
import { createEffect, createMemo, createSignal, type JSX, on, Show } from 'solid-js';
import { HelpDialog } from '../component/dialogs/help.js';
import { RunsDialog } from '../component/dialogs/runs.js';
import { KeyHints } from '../component/footer.js';
import { Logo } from '../component/logo.js';
import { Prompt, type PromptRef } from '../component/prompt/index.js';
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

/** The org's workflows, or why it could not be loaded. */
function orgInfo(root: string): { workflows: string[]; error?: string } {
  try {
    return { workflows: Object.keys(loadOrg(root).workflows) };
  } catch (e) {
    if (e instanceof OrgLoadError && /not found/i.test(e.message))
      return { workflows: [], error: `Org not found: ${root}` };
    return { workflows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** `daemon 0.0.1 · 2 running · 1 queued · ▲ 1 needs you`, or the unreachable notice. */
export function daemonLine(d: ReturnType<typeof useData>['state'], version: string): string {
  if (!d.reachable) return 'Daemon unreachable';
  const running = d.runs.filter((r) => r.status === 'running').length;
  const queued = d.runs.filter((r) => r.status === 'queued').length;
  const needs = d.inbox.length;
  return `daemon ${version} · ${running} running · ${queued} queued${needs ? ` · ▲ ${needs} needs you` : ''}`;
}

/** Whether the `claude` CLI is on the PATH: the natural default adapter then. */
export function claudeOnPath(env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'claude')));
}

export const MOCK_NOTICE =
  'mock runs no model: the nodes complete at once. /adapter claude-code uses your Claude login';

/** `~/dir` for paths under the home directory. */
export function tilde(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function Home(): JSX.Element {
  const theme = useTheme();
  const config = useConfig();
  const data = useData();
  const prefs = usePrefs();
  const route = useRoute();
  const toast = useToast();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  let prompt: PromptRef | undefined;
  const [ctx, setCtx] = createSignal<PromptContext>({
    org: prefs.data.lastOrg ?? join(config.cwd, 'org'),
    project: config.cwd,
    // mock is a test double: it is never the remembered choice, and claude-code wins when claude is installed
    adapter:
      ADAPTERS.find((a) => a === prefs.data.lastAdapter && a !== 'mock') ??
      (claudeOnPath(config.env) ? 'claude-code' : 'mock'),
    workflow: prefs.data.lastWorkflow,
  });
  const org = createMemo(() => orgInfo(ctx().org));
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
  const workflow = () => ctx().workflow ?? org().workflows[0];

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
        {tilde(c.project)}
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
          {tilde(config.cwd)}
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
