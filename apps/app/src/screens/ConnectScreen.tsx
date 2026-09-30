import { useState } from 'react';
import type { Connection } from '../api/connection.js';
import { ds } from '../ds.js';

/** Asks where the daemon is when the app was opened without a token in its URL. */
export function ConnectScreen(props: {
  initialBase: string;
  notice?: string;
  onConnect: (c: Connection) => void;
}): JSX.Element {
  const S = ds();
  const [base, setBase] = useState(props.initialBase);
  const [token, setToken] = useState('');
  return (
    <div className="connect">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (base.trim() && token.trim())
            props.onConnect({ base: base.trim().replace(/\/+$/, ''), token: token.trim() });
        }}
      >
        <h1>Connect to your daemon</h1>
        {props.notice ? <S.Badge tone="warning">{props.notice}</S.Badge> : null}
        <p className="muted" style={{ margin: 0 }}>
          The daemon that served this page and its token. On your own machine, shibaox app opens
          this page already connected.
        </p>
        <S.Input
          label="Daemon URL"
          value={base}
          onChange={(e) => setBase((e.target as HTMLInputElement).value)}
          placeholder="http://127.0.0.1:7433"
        />
        <S.Input
          label="Token"
          type="password"
          value={token}
          onChange={(e) => setToken((e.target as HTMLInputElement).value)}
        />
        <S.Button variant="primary" type="submit" icon="plug">
          Connect
        </S.Button>
      </form>
    </div>
  );
}
