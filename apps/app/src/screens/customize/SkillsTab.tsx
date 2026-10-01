import type { DiscoveredSkill, SkillRow, SkillSource } from '@wizardingcode/shibaox-daemon';
import { useEffect, useMemo, useState } from 'react';
import { ds } from '../../ds.js';
import { Markdown } from '../../markdown/render.js';
import { useAppState, useStore } from '../../store/hooks.js';
import { ConfirmDialog } from './dialogs/ConfirmDialog.js';
import { RolesDialog } from './dialogs/RolesDialog.js';
import { SkillRepoDialog } from './dialogs/SkillRepoDialog.js';
import { SkillFolderDialog, SkillWriteDialog } from './dialogs/SkillWriteDialog.js';
import { inCategory, matches } from './filter.js';
import { AddMenu, AddOrAdded, CardMenu, CategoryMenu, Empty, goTo, Toolbar } from './parts.js';
import type { CustomizeView } from './types.js';

const sourceKey = (s: SkillSource) => (s.path ? `${s.repo}|${s.path}` : s.repo);

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

/** The org's workflows, ready to run as a task (what the Skills screen was). */
function Workflows(props: { query: string }): JSX.Element | null {
  const S = ds();
  const state = useAppState();
  const [running, setRunning] = useState<string | undefined>(undefined);
  const rows = (state.customize?.workflows ?? []).filter((w) =>
    matches(props.query, [w.name, w.description]),
  );
  if (rows.length === 0) return null;
  return (
    <section className="stack-16" aria-label="Workflows">
      <h3>Workflows</h3>
      <div className="grid-2">
        {rows.map((w) => (
          <S.Card
            key={w.name}
            icon={w.conversation ? 'message-square' : 'zap'}
            title={w.name}
            description={
              w.description ||
              (w.conversation ? 'A conversation with the orchestrator.' : undefined)
            }
            aside={
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
      </div>
    </section>
  );
}

type Dialog =
  | { kind: 'roles'; skill: { id: string; name: string } }
  | { kind: 'remove'; skill: SkillRow }
  | { kind: 'open'; skill: SkillRow }
  | { kind: 'repo' }
  | { kind: 'folder' }
  | { kind: 'write' };

/** Skills: yours (with the roles that use them) and the built-in sources to discover. */
export function SkillsTab(props: { view: CustomizeView }): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const c = state.customize;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [adding, setAdding] = useState<string | undefined>(undefined);
  const skills = c?.skills ?? [];
  const yours = new Set(skills.map((s) => s.id));
  const sources = c?.registry.skills ?? [];
  const discover = props.view === 'discover';

  // Discover reads each source's listing once (the daemon caches its clone)
  useEffect(() => {
    if (!discover) return;
    for (const s of sources)
      if (!state.discovered[sourceKey(s)]) void store.discoverSkills(s.repo, s.path);
  }, [discover, sources, state.discovered, store]);

  const shownYours = skills.filter((s) =>
    matches(query, [s.id, s.name, s.description, ...s.roles]),
  );
  const categoriesOf = (src: SkillSource, sk: DiscoveredSkill) => [
    src.name,
    ...sk.path.split('/').filter(Boolean),
  ];
  const categories = useMemo(
    () => [
      ...new Set([...sources.map((s) => s.name), ...sources.flatMap((s) => s.categories ?? [])]),
    ],
    [sources],
  );
  const onAdded = (added: SkillRow[]) => {
    const first = added[0];
    if (added.length === 1 && first)
      setDialog({ kind: 'roles', skill: { id: first.id, name: first.name } });
  };
  const install = (src: SkillSource, sk: DiscoveredSkill) => {
    setAdding(sk.id);
    void store
      .addSkill({
        source: 'repo',
        repo: src.repo,
        ...(src.path ? { path: src.path } : {}),
        ids: [sk.id],
      })
      .then((r) => {
        setAdding(undefined);
        if (r) onAdded(r.added);
      });
  };

  return (
    <>
      <Toolbar
        view={{
          value: props.view,
          dot: skills.some((s) => s.roles.length === 0),
          onChange: (v) => goTo('skills', v),
        }}
        search={{ label: 'Search skills', value: query, onChange: setQuery }}
        category={
          discover ? (
            <CategoryMenu categories={categories} value={category} onChange={setCategory} />
          ) : undefined
        }
        add={
          <AddMenu
            items={[
              {
                id: 'repo',
                label: 'From a repository',
                hint: 'GitHub owner/repo or a git URL',
                icon: 'github',
              },
              {
                id: 'folder',
                label: 'From a folder',
                hint: "on the daemon's machine",
                icon: 'folder',
              },
              { id: 'write', label: 'Write a skill', hint: 'a SKILL.md here', icon: 'file-text' },
            ]}
            onSelect={(id) => setDialog({ kind: id as 'repo' | 'folder' | 'write' })}
          />
        }
      />
      {!c ? <p className="muted">Reading the org…</p> : null}
      {c && !discover ? (
        <>
          {skills.length === 0 ? (
            <Empty>No skills yet. Add one from a repository or write your own.</Empty>
          ) : shownYours.length === 0 ? (
            <Empty>{`Nothing matches “${query.trim()}”.`}</Empty>
          ) : (
            <div className="grid-2">
              {shownYours.map((s) => (
                <S.Card
                  key={s.id}
                  icon="sparkles"
                  title={s.name}
                  description={s.description}
                  meta={
                    s.roles.length ? (
                      <span>{`Used by: ${s.roles.join(', ')}`}</span>
                    ) : (
                      <S.Badge tone="warning">Not used by any role</S.Badge>
                    )
                  }
                  aside={
                    <CardMenu
                      name={s.name}
                      items={[
                        { id: 'open', label: 'Open', icon: 'file-text' },
                        { id: 'roles', label: 'Roles…', icon: 'wrench' },
                        { id: '-', label: '' },
                        { id: 'remove', label: 'Remove', icon: 'trash', tone: 'danger' },
                      ]}
                      onSelect={(id) =>
                        setDialog(
                          id === 'roles'
                            ? { kind: 'roles', skill: { id: s.id, name: s.name } }
                            : { kind: id as 'open' | 'remove', skill: s },
                        )
                      }
                    />
                  }
                />
              ))}
            </div>
          )}
          <Workflows query={query} />
        </>
      ) : null}
      {c && discover ? (
        sources.length === 0 ? (
          <Empty>No skill source is known to this daemon.</Empty>
        ) : (
          sources.map((src) => {
            const listing = state.discovered[sourceKey(src)];
            const rows =
              listing && !('error' in listing)
                ? inCategory(listing.skills, category, (sk) => categoriesOf(src, sk)).filter((sk) =>
                    matches(query, [sk.id, sk.name, sk.description, src.name, src.vendor]),
                  )
                : [];
            if (listing && !('error' in listing) && rows.length === 0) return null;
            if (category && !listing) return null;
            return (
              <section key={sourceKey(src)} className="stack-16" aria-label={src.name}>
                <div className="stack">
                  <h3>{src.name}</h3>
                  <span className="muted">{`by ${src.vendor} · ${src.repo}${src.path ? `/${src.path}` : ''}`}</span>
                </div>
                {!listing ? <p className="muted">{`Reading ${src.repo}…`}</p> : null}
                {listing && 'error' in listing ? (
                  <p className="note">{`Could not read ${src.repo}: ${listing.error}`}</p>
                ) : null}
                {rows.length ? (
                  <div className="grid-2">
                    {rows.map((sk) => (
                      <S.Card
                        key={sk.id}
                        icon="sparkles"
                        title={sk.name}
                        description={sk.description}
                        meta={
                          sk.path.includes('/') ? (
                            <span className="mono">
                              {sk.path.split('/').slice(0, -1).join('/')}
                            </span>
                          ) : undefined
                        }
                        aside={
                          <AddOrAdded
                            name={sk.name}
                            added={yours.has(sk.id)}
                            busy={adding === sk.id}
                            onAdd={() => install(src, sk)}
                          />
                        }
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })
        )
      ) : null}

      {dialog?.kind === 'roles' ? (
        <RolesDialog
          kind="skills"
          id={dialog.skill.id}
          name={dialog.skill.name}
          roles={c?.roles ?? []}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <ConfirmDialog
          title={`Remove ${dialog.skill.name}?`}
          description={
            dialog.skill.roles.length
              ? `${dialog.skill.roles.join(', ')} use it. Its folder is deleted from the org.`
              : 'Its folder is deleted from the org.'
          }
          confirm="Remove"
          check={
            dialog.skill.roles.length
              ? { label: 'Detach from roles first', required: true }
              : undefined
          }
          onConfirm={(detach) => void store.removeSkill(dialog.skill.id, detach)}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'open' ? (
        <S.Sheet
          open
          title={dialog.skill.name}
          subtitle={<span className="mono">{dialog.skill.path}</span>}
          icon="sparkles"
          onClose={() => setDialog(undefined)}
          actions={
            <S.Button
              size="sm"
              variant="quiet"
              icon="copy"
              onClick={() => {
                try {
                  void navigator.clipboard?.writeText(dialog.skill.path);
                } catch {
                  // no clipboard
                }
              }}
            >
              Copy path
            </S.Button>
          }
        >
          <div className="stack-16">
            <Markdown text={dialog.skill.description || '_No description._'} />
            <p className="muted">
              {dialog.skill.roles.length
                ? `Used by ${dialog.skill.roles.join(', ')}.`
                : 'No role uses it yet: Roles… attaches it.'}
            </p>
          </div>
        </S.Sheet>
      ) : null}
      {dialog?.kind === 'repo' ? (
        <SkillRepoDialog onClose={() => setDialog(undefined)} onAdded={onAdded} />
      ) : null}
      {dialog?.kind === 'folder' ? (
        <SkillFolderDialog onClose={() => setDialog(undefined)} onAdded={onAdded} />
      ) : null}
      {dialog?.kind === 'write' ? (
        <SkillWriteDialog onClose={() => setDialog(undefined)} onAdded={onAdded} />
      ) : null}
    </>
  );
}
