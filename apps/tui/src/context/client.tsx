import type { ProjectProfile, RunState } from '@wizardingcode/shibaox-core';
import type {
  DiffResult,
  Envelope,
  Health,
  InboxItem,
  KeyRow,
  ModelChoice,
  OrgConfig,
  OrgConfigPatch,
  OrgInfo,
  ProjectEntry,
  RoutineRow,
  RunSummaryPlus,
  SubmitRequest,
} from '@wizardingcode/shibaox-daemon';
import { createContext, type JSX, type ParentProps, useContext } from 'solid-js';

/** The subset of the daemon client the dashboard uses; the fake implements it in tests. */
export interface DaemonClientLike {
  health(): Promise<Health>;
  listRuns(q?: { status?: string; org?: string }): Promise<RunSummaryPlus[]>;
  getRun(id: string): Promise<RunState>;
  events(
    id: string,
    o?: { since?: string; signal?: AbortSignal; historyOnly?: boolean },
  ): AsyncIterable<Envelope>;
  inbox(): Promise<InboxItem[]>;
  answer(
    id: string,
    a: { approved: boolean; note?: string; via?: 'cli' | 'api' },
  ): Promise<{ runId: string; kind: 'human' | 'approval' }>;
  cancel(id: string): Promise<RunState>;
  steer(id: string, o: { nodeId?: string; note: string }): Promise<RunState>;
  resume(id: string, o?: { budgetUsd?: number }): Promise<RunState>;
  submitRun(req: SubmitRequest): Promise<{ runId: string; warnings: string[] }>;
  diff(id: string): Promise<DiffResult>;
  projectProfile(path: string, orgRoot?: string): Promise<ProjectProfile>;
  models(): Promise<ModelChoice[]>;
  orgConfig(root: string): Promise<OrgConfig>;
  setOrgConfig(root: string, patch: OrgConfigPatch): Promise<OrgConfig>;
  defaultOrg(): Promise<{ root: string; created: boolean }>;
  orgInfo(root: string): Promise<OrgInfo>;
  routines(): Promise<RoutineRow[]>;
  runRoutine(id: string): Promise<{ runId: string }>;
  pauseRoutine(id: string): Promise<RoutineRow>;
  resumeRoutine(id: string): Promise<RoutineRow>;
  projects(): Promise<ProjectEntry[]>;
  keys(): Promise<KeyRow[]>;
  setKey(name: string, value: string): Promise<{ name: string; set: true }>;
  unsetKey(name: string): Promise<{ name: string; removed: boolean }>;
}

const Context = createContext<DaemonClientLike>();

export function ClientProvider(props: ParentProps<{ client: DaemonClientLike }>): JSX.Element {
  return <Context.Provider value={props.client}>{props.children}</Context.Provider>;
}

export function useClient(): DaemonClientLike {
  const c = useContext(Context);
  if (!c) throw new Error('useClient outside ClientProvider');
  return c;
}
