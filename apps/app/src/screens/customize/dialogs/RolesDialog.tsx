import { useState } from 'react';
import { ds } from '../../../ds.js';
import { useStore } from '../../../store/hooks.js';
import { RoleChecks } from '../parts.js';
import type { RoleLinks, RoleRow } from '../types.js';

/** Which roles use a skill or a connector: a checkbox per role, one PUT per role that changed. */
export function RolesDialog(props: {
  kind: 'skills' | 'mcp';
  id: string;
  name: string;
  roles: RoleRow[];
  onClose: () => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const using = props.roles.filter((r) => r[props.kind].includes(props.id)).map((r) => r.id);
  const [picked, setPicked] = useState<string[]>(using);
  const [saving, setSaving] = useState(false);
  const save = () => {
    const changes: { id: string; links: RoleLinks }[] = [];
    for (const r of props.roles) {
      const had = r[props.kind].includes(props.id);
      const has = picked.includes(r.id);
      if (had === has) continue;
      const list = has ? [...r[props.kind], props.id] : r[props.kind].filter((x) => x !== props.id);
      changes.push({ id: r.id, links: { [props.kind]: list } });
    }
    if (changes.length === 0) return props.onClose();
    setSaving(true);
    void store.setRoleLinks(changes).then((ok) => {
      setSaving(false);
      if (ok) props.onClose();
    });
  };
  return (
    <S.Dialog
      open
      title={`Roles for ${props.name}`}
      description={
        props.kind === 'skills'
          ? 'The roles ticked load this skill into their prompt.'
          : 'The roles ticked can call the tools of this connector.'
      }
      icon="wrench"
      width={440}
      onClose={props.onClose}
      footer={
        <>
          <S.Button variant="quiet" onClick={props.onClose}>
            Cancel
          </S.Button>
          <S.Button variant="primary" loading={saving} onClick={save}>
            Save
          </S.Button>
        </>
      }
    >
      <RoleChecks roles={props.roles} value={picked} onChange={setPicked} />
    </S.Dialog>
  );
}
