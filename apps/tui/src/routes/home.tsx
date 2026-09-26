import { basename, join } from 'node:path';
import { useTerminalDimensions } from '@opentui/solid';
import { loadOrg, OrgLoadError } from '@shibaox/schemas';
import { createMemo, createSignal, type JSX, Show } from 'solid-js';
import { Footer } from '../component/footer.js';
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
  type PromptCommand,
  type PromptContext,
  toSubmitRequest,
} from '../model/prompt-commands.js';
import { useTheme } from '../theme/context.js';
import { useToast } from '../ui/toast.js';

export const PLACEHOLDERS = [
  'Add a /health endpoint',
  'Fix the failing tests',
  'What does this repo do?',
];
export const FOOTER_KEYS = 'ctrl+o runs · ctrl+k commands · ? help';

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

export function Home(): JSX.Element {
  const theme = useTheme();
  const config = useConfig();
  const data = useData();
  const prefs = usePrefs();
  const route = useRoute();
  const toast = useToast();
  const dimensions = useTerminalDimensions();
  let prompt: PromptRef | undefined;
  const [ctx, setCtx] = createSignal<PromptContext>({
    org: prefs.data.lastOrg ?? join(config.cwd, 'org'),
    project: config.cwd,
    adapter: ADAPTERS.find((a) => a === prefs.data.lastAdapter) ?? 'mock',
    workflow: prefs.data.lastWorkflow,
  });
  const org = createMemo(() => orgInfo(ctx().org));
  const [error, setError] = createSignal<string | undefined>();
  // the first workflow of the org when none was picked yet
  const workflow = () => ctx().workflow ?? org().workflows[0];

  const onCommand = (cmd: PromptCommand) => {
    setError(undefined);
    if (cmd.command === 'help' || cmd.command === 'runs') return;
    const next = applyPromptCommand(ctx(), cmd, { cwd: config.cwd });
    if ('error' in next) return setError(next.error);
    setCtx(next);
  };
  const onSubmit = async (text: string) => {
    setError(undefined);
    if (org().error) return setError(org().error);
    const wf = workflow();
    if (!wf) return setError('Pick a workflow first: /workflow <name>');
    const req = toSubmitRequest({ ...ctx(), workflow: wf }, text);
    const runId = await data.actions.submit(req);
    if (!runId) return;
    prefs.update({ lastOrg: req.orgRoot, lastAdapter: req.adapter as Adapter, lastWorkflow: wf });
    prompt?.clear();
    data.openRun(runId);
    route.navigate({ type: 'session', runId });
  };

  const contextLine = () => {
    const c = ctx();
    const parts = [
      `org ${basename(join(c.org, '..'))}/${basename(c.org)}`,
      `workflow ${workflow() ?? '—'}`,
      `project ${basename(c.project)}`,
      `adapter ${c.adapter}`,
    ];
    if (c.workspace) parts.push(`workspace ${c.workspace}`);
    if (c.budgetUsd !== undefined) parts.push(`budget ${money(c.budgetUsd)}`);
    return parts.join(' · ');
  };
  const notice = () => error() ?? org().error;
  void toast;

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
        <box width="100%" maxWidth={75} flexShrink={0} flexDirection="column">
          <Prompt
            ref={(r) => {
              prompt = r;
            }}
            placeholders={PLACEHOLDERS}
            workflows={org().workflows}
            onSubmit={(t) => void onSubmit(t)}
            onCommand={onCommand}
          />
          <box flexShrink={0} paddingLeft={2} width="100%">
            <text fg={theme.text.muted} wrapMode="word">
              {contextLine()}
            </text>
          </box>
          <Show when={notice()}>
            <box height={1} flexShrink={0} paddingLeft={2}>
              <text fg={theme.text.feedback.error} wrapMode="none">
                {notice() ?? ''}
              </text>
            </box>
          </Show>
        </box>
        <box flexGrow={1} minHeight={0} />
      </box>
      <Footer left={daemonLine(data.state, config.version)} right={FOOTER_KEYS} />
    </box>
  );
}
