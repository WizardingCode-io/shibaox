import { useEffect, useMemo, useState } from 'react';
import { AppClient } from './api/client.js';
import {
  type Connection,
  clearConnection,
  readConnection,
  saveConnection,
} from './api/connection.js';
import { ds } from './ds.js';
import { useRoute } from './router.js';
import { ChatsScreen } from './screens/ChatsScreen.js';
import { ConnectScreen } from './screens/ConnectScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { Sidebar } from './screens/Sidebar.js';
import { SoonScreen } from './screens/SoonScreen.js';
import { ThreadScreen } from './screens/ThreadScreen.js';
import { StoreContext, useAppState, useStore } from './store/hooks.js';
import { AppStore, type StoreClient } from './store/store.js';

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface AppProps {
  /** A store to use as is (tests); else one is built on the connection. */
  store?: AppStore;
  storage: StorageLike;
  /** The daemon client for a connection (tests hand a fake). */
  connect?: (c: Connection) => StoreClient;
}

function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try {
    localStorage.setItem('shibaox.theme', theme === 'system' ? '' : theme);
  } catch {
    // no storage: the theme lives for the session
  }
}

function Shell(props: {
  base: string;
  onDisconnect: () => void;
  auditUrl: (id: string) => string;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const route = useRoute();
  useEffect(() => applyTheme(state.settings.theme), [state.settings.theme]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const [draft, setDraft] = useState(false);
  const newChat = () => {
    setDraft(true);
    window.location.hash = '#/';
  };
  return (
    <div className="app">
      <Sidebar route={route} onNewChat={newChat} />
      {route.name === 'thread' ? (
        <ThreadScreen rootId={route.id} auditUrl={props.auditUrl} />
      ) : route.name === 'chats' ? (
        <ChatsScreen />
      ) : route.name === 'settings' ? (
        <SettingsScreen base={props.base} onDisconnect={props.onDisconnect} />
      ) : route.name === 'soon' ? (
        <SoonScreen section={route.section} />
      ) : (
        <main className="main">
          <div className="top">
            <h2>New chat</h2>
            <S.AgentStatus status={state.reachable ? 'online' : 'error'} />
          </div>
          <div className="thread">
            <div className="empty">
              <S.Mascot mood={draft ? 'happy' : 'default'} size={120} />
              <h2>What should Shibaox do?</h2>
              <p>
                Describe the work in your own words. It plans, acts, and hands larger work to your
                team.
              </p>
            </div>
          </div>
          <div className="compose">
            <S.Composer
              placeholder="Ask Shibaox to do something…"
              model={state.settings.model?.split('/').pop()}
              onSend={(text) =>
                void store
                  .newChat(text)
                  .then((id) => {
                    window.location.hash = `#/t/${encodeURIComponent(id)}`;
                  })
                  .catch(() => undefined)
              }
            />
          </div>
        </main>
      )}
      {state.error ? (
        <div className="toasts">
          <S.Toast tone="danger" title="That did not work" onClose={() => store.clearError()}>
            {state.error}
          </S.Toast>
        </div>
      ) : null}
    </div>
  );
}

/** The app: the Connect screen until a daemon is known, then the mockup on the store. */
export function App(props: AppProps): JSX.Element {
  const [conn, setConn] = useState<Connection | undefined>(() =>
    readConnection({
      location: window.location,
      storage: props.storage,
      replaceUrl: (url) => window.history.replaceState(null, '', url),
    }),
  );
  const store = useMemo(() => {
    if (!conn) return undefined;
    if (props.store) return props.store;
    const client = props.connect ? props.connect(conn) : new AppClient(conn.base, conn.token);
    return new AppStore({ client, storage: props.storage });
  }, [conn, props.store, props.connect, props.storage]);
  if (!conn || !store)
    return (
      <ConnectScreen
        initialBase={
          window.location.origin.startsWith('http')
            ? window.location.origin
            : 'http://127.0.0.1:7433'
        }
        onConnect={(c) => {
          saveConnection(props.storage, c);
          setConn(c);
        }}
      />
    );
  const auditUrl = (id: string) => `${conn.base}/runs/${encodeURIComponent(id)}/audit?format=md`;
  return (
    <StoreContext.Provider value={store}>
      <Shell
        base={conn.base}
        auditUrl={auditUrl}
        onDisconnect={() => {
          clearConnection(props.storage);
          setConn(undefined);
        }}
      />
    </StoreContext.Provider>
  );
}
