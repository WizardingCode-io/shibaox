import type { RunState } from '@shibaox/core';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { AgentStatus } from '../src/components/AgentStatus.js';
import { RunDetail } from '../src/components/RunDetail.js';
import { RunList } from '../src/components/RunList.js';
import { StreamView } from '../src/components/StreamView.js';
import { TitleBar } from '../src/components/TitleBar.js';
import { Toast } from '../src/components/Toast.js';
import { ToolCallLine } from '../src/components/ToolCallLine.js';
import type { StreamLine } from '../src/stream.js';

const run = (runId: string, status: string, workflow = 'hello-feature') =>
  ({
    runId,
    workflow,
    status,
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    spentUsd: 0.42,
  }) as never;

describe('components', () => {
  it('AgentStatus renders the symbol and the word', () => {
    const { lastFrame } = render(<AgentStatus status="waiting_approval" />);
    expect(lastFrame()).toBe('● Needs you');
  });

  it('RunList marks the selected run and shows id, workflow and status', () => {
    const { lastFrame } = render(
      <RunList
        runs={[run('4f2a1234-x', 'running'), run('b81c5678-x', 'waiting_human')]}
        selectedRunId="b81c5678-x"
        focused
        height={10}
        width={22}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('  4f2a1234 hello-feat');
    expect(frame).toContain('▸ b81c5678 hello-feat');
    expect(frame).toContain('● Working');
    expect(frame).toContain('● Needs you');
  });

  it('RunList says so when there are no runs', () => {
    const { lastFrame } = render(<RunList runs={[]} focused height={5} width={22} />);
    expect(lastFrame()).toContain('No runs yet');
  });

  it('ToolCallLine shows name, summary, duration and a status word', () => {
    const base = { name: 'Read', summary: '{"file_path":"a.ts"}' };
    expect(
      render(
        <ToolCallLine
          tool={{ ...base, status: 'done', durationMs: 40 }}
          depth={0}
          motion={false}
          frame={0}
        />,
      ).lastFrame(),
    ).toBe('> Read {"file_path":"a.ts"}  40 ms  done');
    expect(
      render(
        <ToolCallLine tool={{ ...base, status: 'error' }} depth={1} motion={false} frame={0} />,
      ).lastFrame(),
    ).toBe('    > Read {"file_path":"a.ts"}  error');
    expect(
      render(
        <ToolCallLine
          tool={{ name: 'Bash', summary: 'git push', status: 'approval' }}
          depth={0}
          motion={false}
          frame={0}
        />,
      ).lastFrame(),
    ).toBe('> Bash git push  needs approval');
    expect(
      render(
        <ToolCallLine tool={{ ...base, status: 'running' }} depth={0} motion={false} frame={0} />,
      ).lastFrame(),
    ).toBe('> Read {"file_path":"a.ts"}  …');
    expect(
      render(
        <ToolCallLine tool={{ ...base, status: 'running' }} depth={0} motion frame={1} />,
      ).lastFrame(),
    ).toBe('> Read {"file_path":"a.ts"}  ▃▅▁');
  });

  it('a tool line wider than the pane keeps its duration and status word', () => {
    const long = { name: 'Bash', summary: 'x'.repeat(80), status: 'approval' as const };
    const { lastFrame } = render(
      <Box width={60} height={1}>
        <ToolCallLine tool={long} depth={0} motion={false} frame={0} />
      </Box>,
    );
    expect(lastFrame()).toContain('needs approval');
    expect(lastFrame()?.split('\n')).toHaveLength(1);
    const done = {
      name: 'Bash',
      summary: 'y'.repeat(80),
      status: 'done' as const,
      durationMs: 1234,
    };
    expect(
      render(
        <Box width={60} height={1}>
          <ToolCallLine tool={done} depth={0} motion={false} frame={0} />
        </Box>,
      ).lastFrame(),
    ).toMatch(/1234 ms\s+done/);
  });

  it('StreamView shows the window given by offset', () => {
    const lines: StreamLine[] = ['a', 'b', 'c', 'd', 'e'].map((text) => ({
      kind: 'text',
      nodeId: 'n',
      depth: 0,
      text,
    }));
    const tail = render(
      <StreamView lines={lines} height={3} width={40} offset={2} motion={false} frame={0} />,
    );
    expect(tail.lastFrame()).toBe('c\nd\ne');
    const head = render(
      <StreamView lines={lines} height={3} width={40} offset={0} motion={false} frame={0} />,
    );
    expect(head.lastFrame()).toBe('a\nb\nc');
  });

  it('RunDetail lists the workflow nodes with their state and a header', () => {
    const state = {
      runId: '4f2a1234-x',
      workflow: 'hello-feature',
      status: 'waiting_human',
      spentUsd: 0.42,
      nodes: {
        analyse: { status: 'completed', attempts: 1, approvals: {} },
        implement: { status: 'running', attempts: 2, approvals: {} },
        judge: { status: 'completed', attempts: 1, choice: 'ship', approvals: {} },
      },
      workflowSnapshot: {
        workflow: 'hello-feature',
        start: 'analyse',
        nodes: {
          analyse: { type: 'task', role: 'analyst', next: 'implement' },
          implement: { type: 'task', role: 'backend', next: 'judge' },
          judge: { type: 'decide', by: 'tl', options: ['ship'], next: { ship: 'ship' } },
          ship: { type: 'human', action: 'ship' },
        },
      },
      pendingHumans: [],
      pendingApprovals: [],
      branch: 'shibaox/4f2a1234-x',
    } as unknown as RunState;
    const { lastFrame } = render(
      <RunDetail
        state={state}
        summary={run('4f2a1234-x', 'waiting_human')}
        lines={[]}
        height={12}
        width={80}
        offset={0}
        motion={false}
        frame={0}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('4f2a1234 hello-feature · Needs you · $0.4200 · shibaox/4f2a1234-x');
    expect(frame).toContain('analyse');
    expect(frame).toContain('completed');
    expect(frame).toContain('attempts=2');
    expect(frame).toContain('choice=ship');
    expect(frame).toContain('ship');
    expect(frame).toContain('pending');
  });

  it('TitleBar shows the daemon summary or the unreachable notice', () => {
    const health = {
      version: '0.0.1',
      uptimeSeconds: 3,
      runs: { running: 2, queued: 1, waiting: 0 },
      channels: [],
    };
    expect(
      render(<TitleBar version="0.0.1" health={health} reachable width={80} />).lastFrame(),
    ).toContain('shibaox · daemon 0.0.1 · 2 running · 1 queued');
    expect(render(<TitleBar version="0.0.1" reachable={false} width={80} />).lastFrame()).toContain(
      'Daemon unreachable, retrying…',
    );
  });

  it('Toast renders the text or nothing', () => {
    expect(
      render(<Toast toast={{ text: 'Approved', tone: 'success', until: 1 }} />).lastFrame(),
    ).toBe('Approved');
    expect(render(<Toast />).lastFrame()).toBe('');
  });
});
