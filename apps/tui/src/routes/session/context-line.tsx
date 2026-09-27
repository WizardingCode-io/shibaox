import { loadOrg, type Org } from '@shibaox/schemas';
import { createMemo, createResource, type JSX } from 'solid-js';
import { useClient } from '../../context/client.js';
import { useConfig } from '../../context/config.js';
import { useData } from '../../context/data.js';
import { duration, money, tilde, tokens } from '../../model/format.js';
import { runUsage } from '../../model/stream.js';
import { useTheme } from '../../theme/context.js';

const orgs = new Map<string, Org | undefined>();
/** The org of a run, loaded once per directory (undefined when it cannot be read). */
function orgOf(root: string | undefined): Org | undefined {
  if (!root) return undefined;
  if (!orgs.has(root)) {
    try {
      orgs.set(root, loadOrg(root));
    } catch {
      orgs.set(root, undefined);
    }
  }
  return orgs.get(root);
}

/** The model a run's last task role is routed to by the org (before any runtime says which one ran). */
export function plannedModel(
  org: Org | undefined,
  state:
    | { workflowSnapshot?: { nodes: Record<string, { type: string; role?: string }> } }
    | undefined,
): string | undefined {
  if (!org || !state?.workflowSnapshot) return undefined;
  const tasks = Object.values(state.workflowSnapshot.nodes).filter((n) => n.type === 'task');
  const roleName = tasks.at(-1)?.role;
  const role = roleName ? org.roles[roleName] : undefined;
  if (!role) return undefined;
  return org.models.roles?.[role.role]?.model ?? org.models.tiers?.[role.model_tier];
}

/** `12% ctx` / `24.0k tokens` from a usage record. */
export function contextLabel(
  u: { contextTokens?: number; contextWindow?: number; inputTokens?: number } | undefined,
): { text: string; ratio?: number } | undefined {
  if (!u) return undefined;
  const used = u.contextTokens ?? u.inputTokens;
  if (used === undefined) return undefined;
  if (u.contextWindow) {
    const ratio = used / u.contextWindow;
    return { text: `${Math.round(ratio * 100)}% ctx`, ratio };
  }
  return { text: `${tokens(used)} tokens` };
}

/**
 * The line under the status and under the prompt of a run tab: how full the model's context
 * is, which model, the git branch, the project, the org and workflow, the cost so far and the
 * time. Everything comes from the latest run of the thread.
 */
export function ContextLine(props: { runId: string; elapsed?: string }): JSX.Element {
  const theme = useTheme();
  const data = useData();
  const client = useClient();
  const config = useConfig();
  const latest = () => {
    const runs = data.threadOf(props.runId);
    return runs[runs.length - 1] ?? props.runId;
  };
  const state = () => data.state.states[latest()];
  const summary = () => data.state.runs.find((r) => r.runId === latest());
  const project = () => state()?.project ?? state()?.workspace;
  const [profile] = createResource(
    () => ({ project: project(), org: state()?.orgRoot }),
    (k) => (k.project ? client.projectProfile(k.project, k.org).catch(() => undefined) : undefined),
  );
  const org = createMemo(() => orgOf(state()?.orgRoot));
  const usage = createMemo(() => runUsage(data.timeline(latest())()));
  const model = () => usage()?.model;
  const planned = () => plannedModel(org(), state());
  const ctx = () => contextLabel(usage());
  const branch = () => state()?.branch ?? profile()?.branch;
  const spent = () =>
    data.threadOf(props.runId).reduce((n, id) => n + (data.state.states[id]?.spentUsd ?? 0), 0) ||
    (summary()?.spentUsd ?? 0);
  const muted = theme.text.muted;
  const ctxColor = () => {
    const r = ctx()?.ratio ?? 0;
    return r >= 0.95
      ? theme.text.feedback.error
      : r >= 0.8
        ? theme.text.feedback.warning
        : theme.text.base;
  };
  const sep = () => <span style={{ fg: muted }}>{' · '}</span>;
  return (
    <text fg={theme.text.base} wrapMode="none" flexShrink={1}>
      {ctx() ? (
        <>
          <span style={{ fg: ctxColor() }}>{ctx()?.text ?? ''}</span>
          {sep()}
        </>
      ) : (
        ''
      )}
      {model() ? (
        <>
          {model()}
          {sep()}
        </>
      ) : planned() ? (
        <>
          <span style={{ fg: muted }}>{planned() ?? ''}</span>
          {sep()}
        </>
      ) : (
        ''
      )}
      {branch() ? (
        <>
          <span style={{ fg: theme.text.action.primary.selected }}>{'⎇ '}</span>
          {branch()}
          {sep()}
        </>
      ) : (
        ''
      )}
      {project() ? tilde(project() ?? '', config.env.HOME) : ''}
      {org()?.org.organization ? (
        <>
          {sep()}
          <span style={{ fg: muted }}>{org()?.org.organization ?? ''}</span>
        </>
      ) : (
        ''
      )}
      {sep()}
      <span style={{ fg: theme.text.action.primary.selected }}>
        {summary()?.workflow ?? state()?.workflow ?? ''}
      </span>
      {sep()}
      <span style={{ fg: muted }}>{money(spent())}</span>
      {props.elapsed ? (
        <>
          {sep()}
          <span style={{ fg: muted }}>{props.elapsed}</span>
        </>
      ) : (
        ''
      )}
    </text>
  );
}

export { duration };
