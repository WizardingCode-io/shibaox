import { type ReactNode, useState } from 'react';
import { ds } from '../../ds.js';
import { customizePath, navigate } from '../../router.js';
import type { CustomizeTab, CustomizeView, RoleRow } from './types.js';

type MenuItem = Parameters<Window['Shibaox']['Menu']>[0]['items'][number];

/** The line under the tabs: Yours | Discover, search, the category filter and + Add. */
export function Toolbar(props: {
  view?: { value: CustomizeView; dot: boolean; onChange: (v: CustomizeView) => void };
  search: { label: string; value: string; onChange: (v: string) => void };
  category?: ReactNode;
  add?: ReactNode;
}): JSX.Element {
  const S = ds();
  return (
    <div className="toolbar">
      {props.view ? (
        <S.Segmented
          label="Show"
          items={[
            { id: 'yours', label: 'Yours', dot: props.view.dot },
            { id: 'discover', label: 'Discover' },
          ]}
          value={props.view.value}
          onChange={(id) => props.view?.onChange(id as CustomizeView)}
        />
      ) : null}
      <S.Input
        type="search"
        icon="search"
        placeholder={props.search.label}
        aria-label={props.search.label}
        value={props.search.value}
        onChange={(e) => props.search.onChange((e.target as HTMLInputElement).value)}
      />
      <span className="grow" />
      {props.category}
      {props.add}
    </div>
  );
}

/** A filter Menu with the picked category checked (`undefined`: All). */
export function CategoryMenu(props: {
  categories: string[];
  value: string | undefined;
  onChange: (c: string | undefined) => void;
}): JSX.Element {
  const S = ds();
  const [open, setOpen] = useState(false);
  return (
    <S.Menu
      open={open}
      onClose={() => setOpen(false)}
      align="end"
      anchor={
        <S.Button
          size="sm"
          variant="quiet"
          icon="filter"
          iconRight="chevron-down"
          onClick={() => setOpen((o) => !o)}
        >
          {`Category: ${props.value ?? 'All'}`}
        </S.Button>
      }
      items={[
        { id: '*', label: 'All', checked: props.value === undefined },
        ...props.categories.map((c) => ({ id: c, label: c, checked: c === props.value })),
      ]}
      onSelect={(id) => props.onChange(id === '*' ? undefined : id)}
    />
  );
}

/** The `+ Add` button and its menu. */
export function AddMenu(props: { items: MenuItem[]; onSelect: (id: string) => void }): JSX.Element {
  const S = ds();
  const [open, setOpen] = useState(false);
  return (
    <S.Menu
      open={open}
      onClose={() => setOpen(false)}
      align="end"
      width={280}
      anchor={
        <S.Button
          size="sm"
          variant="primary"
          icon="plus"
          iconRight="chevron-down"
          onClick={() => setOpen((o) => !o)}
        >
          Add
        </S.Button>
      }
      items={props.items}
      onSelect={props.onSelect}
    />
  );
}

/** The `…` menu of a card of yours. */
export function CardMenu(props: {
  name: string;
  items: MenuItem[];
  onSelect: (id: string) => void;
}): JSX.Element {
  const S = ds();
  const [open, setOpen] = useState(false);
  return (
    <S.Menu
      open={open}
      onClose={() => setOpen(false)}
      align="end"
      anchor={
        <S.IconButton
          icon="more-horizontal"
          label={`Actions for ${props.name}`}
          size="sm"
          onClick={() => setOpen((o) => !o)}
        />
      }
      items={props.items}
      onSelect={props.onSelect}
    />
  );
}

/** Discover: `+` to add, or a check when it is already yours. */
export function AddOrAdded(props: {
  name: string;
  added: boolean;
  busy?: boolean;
  onAdd: () => void;
}): JSX.Element {
  const S = ds();
  return props.added ? (
    <span className="added">
      <S.Icon name="check-circle" size={20} label={`${props.name} is added`} />
    </span>
  ) : (
    <S.IconButton
      icon="plus"
      label={`Add ${props.name}`}
      size="sm"
      variant="secondary"
      disabled={props.busy}
      onClick={props.onAdd}
    />
  );
}

/** A key as a badge: present (matcha), or missing (a button into Keys with the row focused). */
export function KeyBadge(props: { name: string; present: boolean }): JSX.Element {
  const S = ds();
  return props.present ? (
    <S.Badge tone="matcha" icon="key">
      {props.name}
    </S.Badge>
  ) : (
    <button
      type="button"
      className="badge-link"
      aria-label={`${props.name} missing`}
      onClick={() => goToKey(props.name)}
    >
      <S.Badge tone="warning" icon="key">
        {props.name}
      </S.Badge>
    </button>
  );
}

export const goToKey = (name: string) => navigate(customizePath({ tab: 'keys', key: name }));
export const goTo = (tab: CustomizeTab, view?: CustomizeView) =>
  navigate(customizePath({ tab, view }));

/** A checkbox per role (native inputs on the design system's tokens). */
export function RoleChecks(props: {
  roles: RoleRow[];
  value: string[];
  onChange: (ids: string[]) => void;
}): JSX.Element {
  if (props.roles.length === 0)
    return <p className="muted">This org has no roles yet (org/roles/*.yaml).</p>;
  return (
    <fieldset className="checks">
      <legend className="sx-field__label">Roles</legend>
      {props.roles.map((r) => (
        <label key={r.id} className="check">
          <input
            type="checkbox"
            checked={props.value.includes(r.id)}
            onChange={(e) =>
              props.onChange(
                e.target.checked ? [...props.value, r.id] : props.value.filter((x) => x !== r.id),
              )
            }
          />
          <span>{r.name}</span>
          {r.name !== r.id ? <span className="mono muted">{r.id}</span> : null}
        </label>
      ))}
    </fieldset>
  );
}

/** What an empty list says. */
export function Empty(props: { children: ReactNode }): JSX.Element {
  return <p className="muted empty-line">{props.children}</p>;
}
