import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { useTerminalDimensions } from '@opentui/solid';
import type { OrgInfo } from '@wizardingcode/shibaox-daemon';
import { DaemonHttpError } from '@wizardingcode/shibaox-daemon/client';
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
import { KeysDialog } from '../component/dialogs/keys.js';
import { RunsDialog } from '../component/dialogs/runs.js';
import { TiersDialog } from '../component/dialogs/tiers.js';
import { KeyHints } from '../component/footer.js';
import { Logo } from '../component/logo.js';
import { Prompt, type PromptRef } from '../component/prompt/index.js';
import { useClient } from '../context/client.js';
import { useConfig } from '../context/config.js';
import { useData } from '../context/data.js';
import { usePrefs } from '../context/prefs.js';
import { useRoute } from '../context/route.js';
import { money, tilde } from '../model/format.js';
import {
  ADAPTERS,
  type Adapter,
  adapterForModel,
  applyPromptCommand,
  COMMAND_HINT,
  type CommandName,
  homeCommands,
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

/** What the home knows about the org, from the daemon; `error` when it could not be described. */
interface OrgView extends OrgInfo {
  error?: string;
}
const NO_ORG: OrgView = { workflows: [], single: [], subscription: false };

const notFound = (e: unknown) =>
  (e instanceof DaemonHttpError && e.status === 404) ||
  (e instanceof Error && /not found/i.test(e.message));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `10.0.0.5:7433` for a remote URL (the footer names the machine, not the socket). */
export function remoteLabel(remote: string): string {
  try {
    return new URL(remote).host;
  } catch {
    return remote;
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

export { tilde } from '../model/format.js';

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
  // the org: the remembered one, else `./org` next to the project, else the daemon's default.
  // With a remote daemon the disk is its own: no local paths, no remembered local org; the
  // project is the first the daemon offers
  const remote = config.remote;
  const localOrg = join(config.cwd, 'org');
  const [ctx, setCtx] = createSignal<PromptContext>({
    org: remote
      ? ''
      : (prefs.data.lastOrg ?? (existsSync(join(localOrg, 'org.yaml')) ? localOrg : '')),
    project: remote ? '' : defaultProject(config.cwd, config.env.HOME),
    // the org's models decide the runtime: a subscription tier runs through claude-code, an API
    // or local tier through our own agent loop (direct); mock is never the remembered choice
    adapter: ADAPTERS.find((a) => a === prefs.data.lastAdapter && a !== 'mock') ?? 'direct',
    model: prefs.data.lastModel,
  });
  // the models a run can be pointed at (`/model`), from the daemon
  const [models] = createResource(() => client.models().catch(() => []));
  // the daemon's default org, asked with a few retries: the daemon may still be settling
  // (a fresh install starts it on demand) and a transient failure must not leave the home
  // without an org
  const [defaultOrg] = createResource<{ root: string; created: boolean; error?: string }>(
    async () => {
      for (const wait of [0, 250, 1000, 2000]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        try {
          return await client.defaultOrg();
        } catch {
          // try again
        }
      }
      return { root: '', created: false, error: 'the daemon did not answer for the default org' };
    },
  );
  createEffect(() => {
    const d = defaultOrg();
    if (d?.root && !ctx().org) setCtx((c) => ({ ...c, org: d.root }));
  });
  // the projects a remote daemon offers (daemon.yaml projects, recent runs, its workspace)
  const [projects] = createResource(() => (remote ? client.projects().catch(() => []) : []));
  createEffect(() => {
    const first = projects()?.[0];
    if (first && !ctx().project) setCtx((c) => ({ ...c, project: first.path }));
  });
  const orgRoot = createMemo(() => ctx().org);
  // bumped when the org's files change under us (a /tiers save) so the daemon describes it again
  const [orgVersion, setOrgVersion] = createSignal(0);
  const [orgRes] = createResource(
    () => ({ root: orgRoot(), v: orgVersion() }),
    async (k): Promise<OrgView> => {
      if (!k.root) return NO_ORG;
      try {
        return await client.orgInfo(k.root);
      } catch (e) {
        return { ...NO_ORG, error: notFound(e) ? `Org not found: ${k.root}` : message(e) };
      }
    },
  );
  // the last description while the next one is on its way: no flash of an empty org
  const org = () => orgRes.latest ?? NO_ORG;
  // what the project is (stack, tests, size), from the daemon; nothing when it cannot say
  const [profile] = createResource(
    () => ({ project: ctx().project, org: orgRoot() }),
    (k) => client.projectProfile(k.project, k.org).catch(() => undefined),
  );
  // only the chosen model (not every context change) may move the adapter
  const chosenModel = createMemo(() => ctx().model);
  createEffect(() => {
    // a chosen model decides the adapter; otherwise the org's tiers do (unless remembered)
    const ref = chosenModel();
    const chosen = ref ? adapterForModel(ref, models() ?? []) : undefined;
    if (!chosen && prefs.data.lastAdapter && prefs.data.lastAdapter !== 'mock') return;
    const adapter = chosen ?? org().adapter ?? (org().subscription ? 'claude-code' : 'direct');
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
    if (cmd.command === 'keys') return dialog.open(() => <KeysDialog />);
    if (cmd.command === 'tiers')
      return dialog.open(() => (
        <TiersDialog orgRoot={orgRoot()} onSaved={() => setOrgVersion((v) => v + 1)} />
      ));
    if (cmd.command === 'key') {
      const [name, ...rest] = cmd.arg.split(/\s+/);
      const value = rest.join(' ').trim();
      if (!name || !value) return setError('Usage: /key NAME VALUE');
      void client
        .setKey(name, value)
        .then(() => toast.show({ message: `${name} saved in the vault`, variant: 'success' }))
        .catch((e: unknown) =>
          setError(`Could not save ${name}: ${e instanceof Error ? e.message : String(e)}`),
        );
      return;
    }
    if (remote && (cmd.command === 'project' || cmd.command === 'org')) {
      // the path lives on the daemon's machine: absolute, and checked there
      const p = cmd.arg.trim();
      const label = cmd.command === 'org' ? 'Org' : 'Project';
      if (!p) return setError(`${label} directory is required`);
      if (!isAbsolute(p))
        return setError(`Remote daemon: absolute path needed (/srv/app)`);
      const check = cmd.command === 'org' ? client.orgInfo(p) : client.projectProfile(p);
      void check.then(
        () => setCtx((c) => (cmd.command === 'org' ? { ...c, org: p } : { ...c, project: p })),
        (e: unknown) => setError(notFound(e) ? `${label} not found: ${p}` : message(e)),
      );
      return;
    }
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
    const runId = await data.actions.submit(req);
    if (!runId) return;
    prefs.update({
      // a remote org is a path on another machine: not remembered for the local daemon
      lastOrg: remote ? prefs.data.lastOrg : req.orgRoot,
      lastAdapter: req.adapter === 'mock' ? undefined : (req.adapter as Adapter),
      lastWorkflow: wf,
      lastModel: req.model,
    });
    prompt?.clear();
    data.openRun(runId);
    route.navigate({ type: 'session', runId });
  };

  // no org known yet: while the daemon is still being asked, say so instead of an error
  const orgPending = () => !orgRoot() && (defaultOrg.loading || defaultOrg() === undefined);
  const notice = () =>
    error() ??
    (orgPending()
      ? 'finding the org…'
      : !orgRoot() && defaultOrg()?.error
        ? defaultOrg()?.error
        : org().error);
  const mockNotice = () => (ctx().adapter === 'mock' ? MOCK_NOTICE : undefined);
  const contextFooter = () => {
    const c = ctx();
    const muted = theme.text.muted;
    const accent = theme.text.action.primary.selected;
    return (
      <text fg={theme.text.base} wrapMode="none">
        <span style={{ fg: muted }}>workflow </span>
        <span style={{ fg: accent }}>{workflow() ?? '—'}</span>
        {c.model ? (
          // a chosen model implies its adapter
          <>
            <span style={{ fg: muted }}> model </span>
            {c.model}
          </>
        ) : (
          <>
            <span style={{ fg: muted }}> adapter </span>
            {c.adapter}
          </>
        )}
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
            commands={homeCommands(org().workflows, models() ?? [])}
            disabled={dialog.depth() > 0}
            onSubmit={(t) => void onSubmit(t)}
            onCommand={onCommand}
            onInput={() => {
              setError(undefined);
              setHint(undefined);
            }}
            onNeedValue={(c) => setHint(COMMAND_HINT[c as CommandName])}
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
          {remote ? `remote ${remoteLabel(remote)}` : tilde(config.cwd, config.env.HOME)}
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
