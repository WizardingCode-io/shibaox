import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppClient } from './api/client.js';
import {
  type Connection,
  clearConnection,
  readConnection,
  saveConnection,
} from './api/connection.js';
import { addFiles, dragHasFiles, encodeFiles } from './attachments.js';
import { ds } from './ds.js';
import { useFileThumbs, useVoice } from './hooks/attachments.js';
import { useRoute } from './router.js';
import { ChatsScreen } from './screens/ChatsScreen.js';
import { ConnectScreen } from './screens/ConnectScreen.js';
import { IntegrationsScreen } from './screens/IntegrationsScreen.js';
import { MemoryScreen } from './screens/MemoryScreen.js';
import { ScheduledScreen } from './screens/ScheduledScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { Sidebar } from './screens/Sidebar.js';
import { SkillsScreen } from './screens/SkillsScreen.js';
import { SoonScreen } from './screens/SoonScreen.js';
import { ThreadScreen } from './screens/ThreadScreen.js';
import { StoreContext, useAppState, useStore } from './store/hooks.js';
import { AppStore, type StoreClient } from './store/store.js';
import { thumbKind } from './thumbs.js';

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

function Shell(props: { base: string; onDisconnect: () => void }): JSX.Element {
  const S = ds();
  const store = useStore();
  const [files, setFiles] = useState<File[]>([]);
  const [newText, setNewText] = useState('');
  const homeThumbs = useFileThumbs(files);
  const homeWords = useCallback((w: string) => setNewText((t) => (t ? `${t} ${w}` : w)), []);
  const homeVoice = useVoice(homeWords, (reason) => store.notice(reason));
  // a file dropped anywhere else must never navigate the tab away from the app
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (dragHasFiles(e.dataTransfer)) e.preventDefault();
    };
    document.addEventListener('dragover', guard);
    document.addEventListener('drop', guard);
    return () => {
      document.removeEventListener('dragover', guard);
      document.removeEventListener('drop', guard);
    };
  }, []);
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
        <ThreadScreen key={route.id} rootId={route.id} />
      ) : route.name === 'chats' ? (
        <ChatsScreen />
      ) : route.name === 'settings' ? (
        <SettingsScreen base={props.base} onDisconnect={props.onDisconnect} />
      ) : route.name === 'section' ? (
        route.section === 'scheduled' ? (
          <ScheduledScreen />
        ) : route.section === 'skills' ? (
          <SkillsScreen />
        ) : route.section === 'memory' ? (
          <MemoryScreen />
        ) : (
          <IntegrationsScreen />
        )
      ) : route.name === 'soon' ? (
        <SoonScreen section={route.section} />
      ) : (
        <main className="main">
          <div className="top">
            <h2>New chat</h2>
            <S.AgentStatus status={state.reachable ? 'online' : 'error'} />
          </div>
          <div className="scroll sx-scroll">
            <div className="thread">
              <div className="empty">
                <h2>{draft ? 'A fresh start' : 'What should Shibaox do?'}</h2>
                <p>
                  Describe the work in your own words. It plans, acts, and hands larger work to your
                  team.
                </p>
              </div>
            </div>
          </div>
          <div className="compose">
            <S.Composer
              placeholder="Ask Shibaox to do something…"
              model={state.settings.model?.split('/').pop()}
              value={newText}
              onChange={setNewText}
              attachments={files.map((f) => ({
                name: f.name,
                size: f.size,
                ...(homeThumbs.get(f)
                  ? { preview: homeThumbs.get(f), previewKind: thumbKind(f.name, f.type) }
                  : {}),
              }))}
              voice={homeVoice.available}
              listening={homeVoice.listening}
              onVoice={homeVoice.available ? homeVoice.toggle : undefined}
              onAttach={(picked) => {
                const r = addFiles(files, picked);
                if (r.notice) store.notice(r.notice);
                else setFiles(r.files);
              }}
              onRemoveAttachment={(i) => setFiles((f) => f.filter((_, j) => j !== i))}
              onSend={(text) =>
                void (async () => {
                  const attachments = await encodeFiles(files);
                  const id = await store.newChat(text, attachments);
                  if (!id) return; // the toast says why; the text and files stay
                  setNewText('');
                  setFiles([]);
                  window.location.hash = `#/t/${encodeURIComponent(id)}`;
                })()
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
  const unauthorized = useSyncExternalStore(
    (l) => store?.subscribe(l) ?? (() => undefined),
    () => store?.get().unauthorized === true,
    () => false,
  );
  if (!conn || !store || unauthorized)
    return (
      <ConnectScreen
        initialBase={
          conn?.base ??
          (window.location.origin.startsWith('http')
            ? window.location.origin
            : 'http://127.0.0.1:7433')
        }
        notice={
          unauthorized
            ? 'The daemon refused the token. Enter the current one (shibaox app prints an address with it).'
            : undefined
        }
        onConnect={(c) => {
          saveConnection(props.storage, c);
          setConn(c);
        }}
      />
    );
  return (
    <StoreContext.Provider value={store}>
      <Shell
        base={conn.base}
        onDisconnect={() => {
          clearConnection(props.storage);
          setConn(undefined);
        }}
      />
    </StoreContext.Provider>
  );
}
