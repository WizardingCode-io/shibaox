import type { DiscoveredSkill, SkillRow } from '@wizardingcode/shibaox-daemon';
import { useState } from 'react';
import { ds } from '../../../ds.js';
import { useAppState, useStore } from '../../../store/hooks.js';
import { splitRepo } from '../filter.js';

/** "From a repository": what `owner/repo[/path]` (or a git URL) offers, pick, install. */
export function SkillRepoDialog(props: {
  onClose: () => void;
  onAdded: (added: SkillRow[]) => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const yours = new Set((state.customize?.skills ?? []).map((s) => s.id));
  const [input, setInput] = useState('');
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<
    { repo: string; path?: string; skills: DiscoveredSkill[] } | { error: string } | undefined
  >(undefined);
  const [picked, setPicked] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const look = () => {
    const { repo, path } = splitRepo(input);
    if (!repo) return;
    setLooking(true);
    void store.discoverSkills(repo, path).then((r) => {
      setLooking(false);
      if ('error' in r) return setFound(r);
      setFound({ repo, ...(path ? { path } : {}), skills: r.skills });
      setPicked(r.skills.filter((s) => !yours.has(s.id)).map((s) => s.id));
    });
  };
  const listing = found && !('error' in found) ? found : undefined;
  return (
    <S.Dialog
      open
      title="Add skills from a repository"
      description="A GitHub owner/repo (optionally /path inside it) or a git URL. Shibaox clones it shallow and lists every folder with a SKILL.md."
      icon="github"
      width={560}
      onClose={props.onClose}
      footer={
        <>
          <S.Button variant="quiet" onClick={props.onClose}>
            Cancel
          </S.Button>
          <S.Button
            variant="primary"
            disabled={!listing || picked.length === 0}
            loading={installing}
            onClick={() => {
              if (!listing) return;
              setInstalling(true);
              void store
                .addSkill({
                  source: 'repo',
                  repo: listing.repo,
                  ...(listing.path ? { path: listing.path } : {}),
                  ids: picked,
                })
                .then((r) => {
                  setInstalling(false);
                  if (!r) return;
                  props.onClose();
                  props.onAdded(r.added);
                });
            }}
          >
            {`Install ${picked.length}`}
          </S.Button>
        </>
      }
    >
      <div className="form">
        <form
          className="save-row"
          onSubmit={(e) => {
            e.preventDefault();
            look();
          }}
        >
          <S.Input
            label="Repository"
            placeholder="anthropics/skills"
            value={input}
            onChange={(e) => setInput((e.target as HTMLInputElement).value)}
          />
          <S.Button type="submit" loading={looking} disabled={!input.trim()}>
            Look
          </S.Button>
        </form>
        {found && 'error' in found ? (
          <p className="note">{`Could not read it: ${found.error}`}</p>
        ) : null}
        {listing && listing.skills.length === 0 ? (
          <p className="muted">No folder with a SKILL.md there.</p>
        ) : null}
        {listing && listing.skills.length > 0 ? (
          <fieldset className="checks">
            <legend className="sx-field__label">{`${listing.skills.length} found`}</legend>
            {listing.skills.map((s) => {
              const added = yours.has(s.id);
              return (
                <label key={s.id} className="check">
                  <input
                    type="checkbox"
                    disabled={added}
                    checked={added || picked.includes(s.id)}
                    onChange={(e) =>
                      setPicked((p) =>
                        e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id),
                      )
                    }
                  />
                  <span className="mono">{s.id}</span>
                  <span className="muted check__desc">{s.description}</span>
                  {added ? <S.Badge>already added</S.Badge> : null}
                </label>
              );
            })}
          </fieldset>
        ) : null}
      </div>
    </S.Dialog>
  );
}
