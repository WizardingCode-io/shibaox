import { createInterface } from 'node:readline/promises';
import { isTerminal, type RunStatus } from '@wizardingcode/shibaox-core';
import { type DaemonClient, DaemonHttpError, type Envelope } from '@wizardingcode/shibaox-daemon';
import { exitCodeFor, formatState, type Out } from '../output.js';

const short = (id: string) => id.slice(0, 8);

function summarizeInput(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input) ?? String(input);
  } catch {
    s = String(input);
  }
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
}

/** One text line per frame, indented when it comes from a subagent. */
export function formatEnvelope(e: Envelope): string | undefined {
  if (e.kind === 'run') {
    const ev = e.event;
    const node = 'nodeId' in ev ? ` ${ev.nodeId}` : '';
    const extra =
      ev.type === 'NodeFailed'
        ? `  ${ev.error}`
        : ev.type === 'RunCancelled'
          ? `  ${ev.reason}`
          : ev.type === 'DecisionMade'
            ? `  ${ev.choice}`
            : '';
    return `[${short(ev.runId)}] ${ev.type}${node}${extra}`;
  }
  if (e.kind === 'runtime') {
    const r = e.event.event;
    const pad = 'parentToolUseId' in r && r.parentToolUseId ? '    ' : '  ';
    switch (r.type) {
      case 'text':
        return r.text
          .split('\n')
          .map((l) => `${pad}${l}`)
          .join('\n');
      case 'tool_use':
        return `${pad}> ${r.name} ${summarizeInput(r.input)}`;
      case 'tool_result':
        return `${pad}< ${r.name}${r.durationMs === undefined ? '' : ` (${r.durationMs} ms)`}`;
      case 'session':
        return `${pad}session ${r.sessionId}`;
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * Prints a run's stream until it ends. With a TTY, a pending human or approval is asked
 * right here and answered through the inbox; without one, the command to answer is printed.
 * Returns the exit code (0 completed, 2 otherwise; 0 when interrupted by the user).
 */
export async function followRun(
  client: Pick<DaemonClient, 'events' | 'getRun' | 'inbox' | 'answer'>,
  runId: string,
  o: { since?: string; signal?: AbortSignal; interactive?: boolean; reconnectMs?: number },
  out: Out,
): Promise<number> {
  const interactive = o.interactive ?? Boolean(process.stdin.isTTY && !out.json);
  let status: string | undefined;
  let since = o.since;
  try {
    // a stream that ends without an `end` frame was cut (a proxy timeout, a network blip): the
    // run goes on, so the stream is reopened after the last frame seen
    while (status === undefined && !o.signal?.aborted) {
      let cut = true;
      for await (const e of client.events(runId, { since, signal: o.signal })) {
        since = e.cursor;
        out.obj(e);
        const line = formatEnvelope(e);
        if (line) out.line(line);
        if (e.kind === 'end') {
          status = e.status;
          cut = false;
          break;
        }
        await onFrame(e);
      }
      if (status !== undefined || o.signal?.aborted || !cut) break;
      const state = await client.getRun(runId);
      if (isTerminal(state.status as RunStatus)) {
        status = state.status;
        break;
      }
      out.line('The connection to the daemon was cut; reconnecting…');
      await new Promise((r) => setTimeout(r, o.reconnectMs ?? 1000));
    }
  } catch (e) {
    if (o.signal?.aborted) {
      out.line(`\nRun ${runId} keeps running. Follow it with: shibaox follow ${runId}`);
      return 0;
    }
    throw e;
  }
  if (o.signal?.aborted) {
    out.line(`\nRun ${runId} keeps running. Follow it with: shibaox follow ${runId}`);
    return 0;
  }
  const state = await client.getRun(runId);
  for (const l of formatState(state)) out.line(l);
  out.obj({ final: state });
  return exitCodeFor(status ?? state.status);

  async function onFrame(e: Envelope): Promise<void> {
    if (
      e.kind === 'run' &&
      (e.event.type === 'HumanRequested' || e.event.type === 'ToolApprovalRequested')
    ) {
      const id =
        e.event.type === 'HumanRequested'
          ? `human:${runId}:${e.event.nodeId}`
          : `approval:${e.event.approvalId}`;
      const prompt =
        e.event.type === 'HumanRequested' ? e.event.prompt : `Allow ${e.event.command}?`;
      // history replays old requests too: only ask about what is still open
      const open = (await client.inbox()).some((i) => i.id === id);
      if (!open) return;
      if (interactive) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = (await rl.question(`\n[${e.event.nodeId}] ${prompt} (y/n) `))
            .trim()
            .toLowerCase();
          await client.answer(id, { approved: answer === 'y' || answer === 'yes', via: 'cli' });
        } catch (err) {
          // answered elsewhere (Telegram, another terminal) while the prompt was open
          if (err instanceof DaemonHttpError && err.status === 409)
            out.line('Already answered elsewhere; following on.');
          else throw err;
        } finally {
          rl.close();
        }
      } else out.line(`Waiting for you: shibaox approve ${id}`);
    }
  }
}
