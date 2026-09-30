import { useEffect } from 'react';
import { ds } from '../ds.js';
import { useAppState, useStore } from '../store/hooks.js';

/** What Shibaox knows about the project and the org. */
export function MemoryScreen(): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  useEffect(() => {
    void store.loadMemory();
  }, [store]);
  const m = state.memory;
  const p = m?.profile;
  const org = m?.org;
  return (
    <main className="main">
      <div className="top">
        <h2>Memory</h2>
      </div>
      <div className="page">
        <h3>The project</h3>
        {p ? (
          <S.Card
            icon="folder"
            title={p.name}
            description={p.path}
            footer={
              <div className="row muted">
                <span>{p.git ? `git · ${p.branch ?? 'detached'}` : 'not a git repository'}</span>
                <span>· {p.stack.join(', ') || 'stack unknown'}</span>
                {p.packageManager ? <span>· {p.packageManager}</span> : null}
                {p.testCommand ? <span>· tests: {p.testCommand}</span> : null}
                <span>
                  · {p.files}
                  {p.truncated ? '+' : ''} files
                </span>
              </div>
            }
          />
        ) : (
          <p className="muted">{m?.error ?? 'Reading the project…'}</p>
        )}
        <h3>The org</h3>
        {org ? (
          <S.Card
            icon="brain"
            title={org.organization}
            description={org.root}
            footer={
              <div className="row muted">
                <span>adapter {org.adapter ?? 'direct'}</span>
                {Object.entries(org.tiers).map(([tier, ref]) => (
                  <span key={tier}>
                    · {tier}: {ref}
                  </span>
                ))}
                {org.judge ? <span>· judge: {org.judge}</span> : null}
                {org.per_run_usd !== undefined ? <span>· ${org.per_run_usd} per run</span> : null}
              </div>
            }
          />
        ) : (
          <p className="muted">Reading the org…</p>
        )}
        <h3>Notes</h3>
        <p className="muted">
          Every run leaves a note in the org's vault (10-projects/&lt;project&gt;/runs), routines
          keep their continuity under 90-system/routines, and the orchestrator's remember/recall
          work on the same files. They live on the daemon's machine, next to the org.
        </p>
      </div>
    </main>
  );
}
