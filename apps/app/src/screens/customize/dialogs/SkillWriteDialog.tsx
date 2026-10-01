import type { SkillRow } from '@wizardingcode/shibaox-daemon';
import { useState } from 'react';
import { ds } from '../../../ds.js';
import { useStore } from '../../../store/hooks.js';
import { ID_RE } from '../filter.js';
import { SkippedNote } from '../parts.js';
import { settle } from '../skill-results.js';

const template = (id: string) => `---
name: ${id || 'my-skill'}
description: When to use this skill, in one sentence.
---

# ${id || 'My skill'}

What the agent should do, step by step, and what good output looks like.
`;

/** "Write a skill": an id and its SKILL.md, saved as `org/skills/<id>/SKILL.md`. */
export function SkillWriteDialog(props: {
  onClose: () => void;
  onAdded: (added: SkillRow[]) => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const [id, setId] = useState('');
  const [content, setContent] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const ok = ID_RE.test(id.trim());
  const text = content ?? template(id.trim());
  return (
    <S.Dialog
      open
      title="Write a skill"
      description="Saved as org/skills/<id>/SKILL.md; the frontmatter's name and description show on its card."
      icon="file-text"
      width={600}
      onClose={props.onClose}
      footer={
        <>
          <S.Button variant="quiet" onClick={props.onClose}>
            Cancel
          </S.Button>
          <S.Button
            variant="primary"
            disabled={!ok || !text.trim()}
            loading={saving}
            onClick={() => {
              setSaving(true);
              void store.addSkill({ source: 'inline', id: id.trim(), content: text }).then((r) => {
                setSaving(false);
                if (!r) return;
                setSkipped(
                  settle(r, {
                    close: props.onClose,
                    onAdded: props.onAdded,
                    notice: (m) => store.notice(m),
                  }),
                );
              });
            }}
          >
            Save
          </S.Button>
        </>
      }
    >
      <div className="form">
        <SkippedNote lines={skipped} />
        <S.Input
          label="Id"
          placeholder="release-notes"
          value={id}
          error={id && !ok ? 'Letters, digits, - _ :' : undefined}
          onChange={(e) => setId((e.target as HTMLInputElement).value)}
        />
        <S.Textarea
          label="SKILL.md"
          rows={12}
          className="mono"
          value={text}
          onChange={(e) => setContent((e.target as HTMLTextAreaElement).value)}
        />
      </div>
    </S.Dialog>
  );
}

/** "From a folder": a path on the daemon's machine, copied into the org (local daemon only). */
export function SkillFolderDialog(props: {
  onClose: () => void;
  onAdded: (added: SkillRow[]) => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  return (
    <S.Dialog
      open
      title="Add a skill from a folder"
      description="A folder with a SKILL.md on the daemon's machine (or one with several skill folders). It is copied into the org."
      icon="folder"
      width={520}
      onClose={props.onClose}
      footer={
        <>
          <S.Button variant="quiet" onClick={props.onClose}>
            Cancel
          </S.Button>
          <S.Button
            variant="primary"
            disabled={!path.trim()}
            loading={saving}
            onClick={() => {
              setSaving(true);
              void store.addSkill({ source: 'folder', path: path.trim() }).then((r) => {
                setSaving(false);
                if (!r) return;
                setSkipped(
                  settle(r, {
                    close: props.onClose,
                    onAdded: props.onAdded,
                    notice: (m) => store.notice(m),
                  }),
                );
              });
            }}
          >
            Add
          </S.Button>
        </>
      }
    >
      <div className="form">
        <SkippedNote lines={skipped} />
        <S.Input
          label="Folder"
          placeholder="/Users/me/skills/release-notes"
          value={path}
          onChange={(e) => setPath((e.target as HTMLInputElement).value)}
        />
      </div>
    </S.Dialog>
  );
}
