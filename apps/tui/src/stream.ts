export interface ToolInfo {
  id?: string;
  name: string;
  summary: string;
  status: 'running' | 'done' | 'error' | 'approval';
  durationMs?: number;
}

/** One line of a run's stream, derived from the daemon's SSE frames. */
export interface StreamLine {
  kind: 'text' | 'tool' | 'session' | 'event';
  nodeId: string;
  /** 1 for lines produced inside a subagent. */
  depth: 0 | 1;
  text: string;
  tool?: ToolInfo;
}

export const STREAM_LIMIT = 2000;
