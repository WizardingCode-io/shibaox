import { describe, expect, it } from 'vitest';
import { AppStore } from '../src/store.js';

const run = (runId: string, status: string, updatedAt = '2026-09-26T10:00:00.000Z') =>
  ({ runId, workflow: 'wf', status, createdAt: updatedAt, updatedAt, spentUsd: 0 }) as never;

describe('AppStore', () => {
  it('selects the first visible run and keeps the selection across refreshes', () => {
    const s = new AppStore();
    s.setRuns([run('a', 'completed'), run('b', 'running')]);
    expect(s.get().selectedRunId).toBe('b'); // active first
    s.setRuns([run('c', 'queued'), run('b', 'running')]);
    expect(s.get().selectedRunId).toBe('b');
    s.setRuns([run('c', 'queued')]);
    expect(s.get().selectedRunId).toBe('c');
  });

  it('moveSelection wraps within the visible list', () => {
    const s = new AppStore();
    s.setRuns([run('a', 'running'), run('b', 'running')]);
    s.moveSelection(1);
    expect(s.get().selectedRunId).toBe('b');
    s.moveSelection(1);
    expect(s.get().selectedRunId).toBe('a');
    s.moveSelection(-1);
    expect(s.get().selectedRunId).toBe('b');
  });

  it('filter active hides terminal runs older than 24 h', () => {
    const s = new AppStore();
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    s.setRuns([run('a', 'completed', old), run('b', 'completed'), run('c', 'running')]);
    expect(s.visibleRuns().map((r) => r.runId)).toEqual(['c', 'b']);
    s.setFilter('all');
    expect(s.visibleRuns().map((r) => r.runId)).toEqual(['c', 'b', 'a']);
  });

  it('pushLines caps a stream at 2000 lines and notifies subscribers once', () => {
    const s = new AppStore();
    let n = 0;
    s.subscribe(() => n++);
    const lines = Array.from(
      { length: 2500 },
      (_, i) => ({ kind: 'text', nodeId: 'x', depth: 0, text: `l${i}` }) as never,
    );
    s.pushLines('r', lines);
    expect(s.get().streams.r).toHaveLength(2000);
    expect(s.get().streams.r?.[0]).toMatchObject({ text: 'l500' });
    expect(n).toBe(1);
  });

  it('toasts expire', () => {
    const s = new AppStore();
    s.showToast('hi', 'info', 1000);
    expect(s.get().toast).toEqual({ text: 'hi', tone: 'info', until: 6000 });
    s.clearExpiredToast(5999);
    expect(s.get().toast).toBeDefined();
    s.clearExpiredToast(6001);
    expect(s.get().toast).toBeUndefined();
  });

  it('reachability drives actionsEnabled', () => {
    const s = new AppStore();
    expect(s.get().actionsEnabled).toBe(true);
    s.setReachable(false);
    expect(s.get().actionsEnabled).toBe(false);
    s.setReachable(true);
    expect(s.get().actionsEnabled).toBe(true);
  });
});
