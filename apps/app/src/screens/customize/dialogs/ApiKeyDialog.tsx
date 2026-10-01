import { useState } from 'react';
import { ds } from '../../../ds.js';
import { useAppState, useStore } from '../../../store/hooks.js';
import { ConfirmDialog } from './ConfirmDialog.js';

export const HIGGSFIELD_KEY = 'HIGGSFIELD_API_KEY';
const KEYS_URL = 'https://open.higgsfield.ai/api-keys';
const COPY = 'Paste the API key copied from open.higgsfield.ai. Paste it as-is.';
/** The key is an `id:secret` pair; the daemon checks it more strictly. */
const PAIR_RE = /^\S+:\S+$/;
const PAIR_ERROR = 'Copy the whole key from open.higgsfield.ai (it has a colon)';

/**
 * The Higgsfield API key: Connect (one password field, pasted as-is) while none is saved,
 * else Manage (masked, its validity, Replace and Remove; a key from the environment stays).
 */
export function ApiKeyDialog(props: {
  /** What the daemon's probe said about the saved key ("accepted", "rejected… (401)"). */
  validity?: { ok: boolean; detail?: string };
  onClose: () => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const row = state.customize?.keys.find((k) => k.name === HIGGSFIELD_KEY);
  const [view, setView] = useState<'form' | 'manage' | 'confirm'>(row?.set ? 'manage' : 'form');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const save = () => {
    const v = value.trim();
    if (!v) return;
    if (!PAIR_RE.test(v)) {
      setError(PAIR_ERROR);
      return;
    }
    setSaving(true);
    void store.setKey(HIGGSFIELD_KEY, v).then((ok) => {
      setSaving(false);
      if (ok) props.onClose();
    });
  };

  if (view === 'confirm')
    return (
      <ConfirmDialog
        title="Remove the API key?"
        description="Shibaox stops using the Higgsfield API until a key is connected again; on Auto, generation goes back to your account."
        confirm="Remove"
        onClose={() => setView('manage')}
        onConfirm={() => {
          void store.unsetKey(HIGGSFIELD_KEY).then((ok) => {
            if (ok) props.onClose();
          });
        }}
      />
    );

  if (view === 'manage' && row?.set) {
    const fromEnv = row.source === 'env';
    return (
      <S.Dialog
        open
        title="Manage API key"
        description="The Higgsfield API key Shibaox generates with."
        icon="key"
        width={480}
        onClose={props.onClose}
        footer={
          <>
            {fromEnv ? null : (
              <S.Button variant="quiet" onClick={() => setView('confirm')}>
                Remove
              </S.Button>
            )}
            <span className="grow" />
            <S.Button variant="secondary" onClick={() => setView('form')}>
              Replace
            </S.Button>
            <S.Button variant="primary" onClick={props.onClose}>
              Done
            </S.Button>
          </>
        }
      >
        <div className="form">
          <div className="row">
            <span className="mono">{row.masked ?? 'set'}</span>
            <S.Badge>{fromEnv ? 'environment' : 'vault'}</S.Badge>
            {props.validity ? (
              <S.Badge tone={props.validity.ok ? 'matcha' : 'warning'}>
                {props.validity.detail ?? (props.validity.ok ? 'valid' : 'not valid')}
              </S.Badge>
            ) : null}
          </div>
          {fromEnv ? (
            <p className="muted">
              It comes from the daemon's environment: remove it there. A key saved here takes its
              place.
            </p>
          ) : null}
        </div>
      </S.Dialog>
    );
  }

  return (
    <S.Dialog
      open
      title={row?.set ? 'Replace API key' : 'Connect API key'}
      description={COPY}
      icon="key"
      width={480}
      onClose={props.onClose}
      footer={
        <>
          <S.Button variant="quiet" onClick={props.onClose}>
            Cancel
          </S.Button>
          <S.Button variant="primary" loading={saving} disabled={!value.trim()} onClick={save}>
            Save
          </S.Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <S.Input
          type="password"
          aria-label="API key"
          placeholder="id:secret"
          autoComplete="off"
          spellCheck={false}
          value={value}
          error={error}
          onChange={(e) => {
            setValue((e.target as HTMLInputElement).value);
            setError(undefined);
          }}
        />
        <a
          className="sx-btn sx-btn--quiet sx-btn--sm"
          href={KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Get a key
        </a>
      </form>
    </S.Dialog>
  );
}
