import { useEffect, useState } from 'react';
import { ds } from '../ds.js';
import { useAppState, useStore } from '../store/hooks.js';

function RunTask(props: { workflow: string; onDone: () => void }): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const [text, setText] = useState('');
  const [project, setProject] = useState(state.settings.project ?? '');
  const [model, setModel] = useState(state.settings.model ?? '');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        void store
          .runWorkflow({
            workflow: props.workflow,
            text: text.trim(),
            ...(project.trim() ? { project: project.trim() } : {}),
            ...(model.trim() ? { model: model.trim() } : {}),
          })
          .then((id) => {
            if (!id) return;
            window.location.hash = `#/t/${encodeURIComponent(id)}`;
            props.onDone();
          });
      }}
    >
      <S.Input
        label="Request"
        placeholder="What should this workflow do?"
        value={text}
        onChange={(e) => setText((e.target as HTMLInputElement).value)}
      />
      <S.Input
        label="Project"
        placeholder="A path on the daemon machine (empty = the default)"
        value={project}
        onChange={(e) => setProject((e.target as HTMLInputElement).value)}
      />
      <S.Input
        label="Model"
        placeholder="provider/model (empty = the org's tiers)"
        value={model}
        onChange={(e) => setModel((e.target as HTMLInputElement).value)}
      />
      <div className="row">
        <S.Button variant="primary" type="submit" icon="play">
          Start
        </S.Button>
        <S.Button variant="quiet" type="button" onClick={props.onDone}>
          Cancel
        </S.Button>
      </div>
    </form>
  );
}

/** The org's workflows, ready to run, and the catalog. */
export function SkillsScreen(): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const [running, setRunning] = useState<string | undefined>(undefined);
  useEffect(() => {
    void store.loadSkills();
  }, [store]);
  const skills = state.skills;
  return (
    <main className="main">
      <div className="top">
        <h2>Skills</h2>
        {skills ? <span className="muted">{skills.org}</span> : null}
      </div>
      <div className="page">
        <h3>Workflows</h3>
        {(skills?.workflows ?? []).map((w) => (
          <S.Card
            key={w.name}
            icon={w.conversation ? 'message-square' : 'zap'}
            title={w.name}
            description={
              w.description ||
              (w.conversation ? 'A conversation with the orchestrator.' : undefined)
            }
            action={
              running === w.name ? undefined : (
                <S.Button size="sm" icon="play" onClick={() => setRunning(w.name)}>
                  Run task
                </S.Button>
              )
            }
          >
            {running === w.name ? (
              <RunTask workflow={w.name} onDone={() => setRunning(undefined)} />
            ) : null}
          </S.Card>
        ))}
        {(skills?.catalog.filter((c) => c.type !== 'mcp').length ?? 0) > 0 ? (
          <>
            <h3>Catalog</h3>
            {skills?.catalog
              .filter((c) => c.type !== 'mcp')
              .map((c) => (
                <S.Card
                  key={c.id}
                  icon={c.type === 'mcp' ? 'plug' : 'zap'}
                  title={c.id}
                  description={c.description}
                  action={<S.Badge>{c.type}</S.Badge>}
                />
              ))}
          </>
        ) : null}
      </div>
    </main>
  );
}
