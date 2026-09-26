import type { JSX } from 'solid-js';
import { useKeys } from '../../context/keys.js';
import { useTheme } from '../../theme/context.js';
import { Dialog } from '../../ui/dialog.js';

/** `<message> (y/n)`: y runs onYes, n and esc run onNo. */
export function Confirm(props: {
  message: string;
  onYes: () => void;
  onNo: () => void;
}): JSX.Element {
  const theme = useTheme().surface('dialog');
  useKeys('dialog', (key) => {
    if (key.name === 'y') {
      props.onYes();
      return true;
    }
    if (key.name === 'n') {
      props.onNo();
      return true;
    }
    return false;
  });
  return (
    <Dialog centered onClose={props.onNo}>
      <text fg={theme.text.base}>{`${props.message} (y/n)`}</text>
    </Dialog>
  );
}
