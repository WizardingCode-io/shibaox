import { ds } from '../ds.js';
import { useAppState, useStore } from '../store/hooks.js';

export function SettingsScreen(props: { base: string; onDisconnect: () => void }): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const s = state.settings;
  return (
    <main className="main">
      <div className="top">
        <h2>Settings</h2>
      </div>
      <div className="page">
        <h3>Theme</h3>
        <S.Tabs
          items={[
            { id: 'light', label: 'Light' },
            { id: 'dark', label: 'Dark' },
            { id: 'system', label: 'System' },
          ]}
          value={s.theme}
          onChange={(id) => store.setSettings({ theme: id as 'light' | 'dark' | 'system' })}
        />
        <h3>You</h3>
        <S.Input
          label="Your name"
          value={s.name ?? ''}
          onChange={(e) =>
            store.setSettings({ name: (e.target as HTMLInputElement).value || undefined })
          }
          placeholder="How the sidebar greets you"
        />
        <h3>New chats</h3>
        <S.Input
          label="Project"
          value={s.project ?? ''}
          onChange={(e) =>
            store.setSettings({ project: (e.target as HTMLInputElement).value || undefined })
          }
          hint="A path on the daemon's machine; empty = the first project the daemon offers"
        />
        <S.Input
          label="Org"
          value={s.org ?? ''}
          onChange={(e) =>
            store.setSettings({ org: (e.target as HTMLInputElement).value || undefined })
          }
          hint="Empty = the daemon's default org"
        />
        <S.Input
          label="Model"
          value={s.model ?? ''}
          onChange={(e) =>
            store.setSettings({ model: (e.target as HTMLInputElement).value || undefined })
          }
          hint="provider/model; empty = the org's tiers"
        />
        <h3>Daemon</h3>
        <p className="muted">
          {props.base} · version {state.health?.version ?? '?'} ·{' '}
          {state.reachable ? 'reachable' : 'not reachable'}
        </p>
        <div className="row">
          <S.Button variant="danger" size="sm" onClick={props.onDisconnect}>
            Disconnect
          </S.Button>
        </div>
      </div>
    </main>
  );
}
