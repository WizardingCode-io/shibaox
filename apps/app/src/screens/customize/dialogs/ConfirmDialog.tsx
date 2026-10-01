import { useState } from 'react';
import { ds } from '../../../ds.js';

/** Asks before something that cannot be undone; an optional box must be ticked first. */
export function ConfirmDialog(props: {
  title: string;
  description: string;
  confirm: string;
  /** A checkbox under the text; `required` keeps the button off until it is ticked. */
  check?: { label: string; required: boolean };
  onConfirm: (checked: boolean) => void;
  onClose: () => void;
}): JSX.Element {
  const S = ds();
  const [checked, setChecked] = useState(false);
  return (
    <S.Dialog
      open
      title={props.title}
      description={props.description}
      icon="triangle-alert"
      width={440}
      onClose={props.onClose}
      footer={
        <>
          <S.Button variant="quiet" onClick={props.onClose}>
            Cancel
          </S.Button>
          <S.Button
            variant="danger"
            disabled={props.check?.required === true && !checked}
            onClick={() => {
              props.onClose();
              props.onConfirm(checked);
            }}
          >
            {props.confirm}
          </S.Button>
        </>
      }
    >
      {props.check ? (
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>{props.check.label}</span>
        </label>
      ) : null}
    </S.Dialog>
  );
}
