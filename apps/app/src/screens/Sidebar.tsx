import type { RunSummaryPlus } from '@wizardingcode/shibaox-daemon';
import { requestText } from '@wizardingcode/shibaox-view';
import { ds } from '../ds.js';
import { navigate, type Route } from '../router.js';
import { useAppState, useStore } from '../store/hooks.js';

const SECTIONS = [
  { id: 'chats', label: 'Chats', icon: 'message-square', path: '#/chats' },
  { id: 'scheduled', label: 'Scheduled', icon: 'clock', path: '#/soon/scheduled' },
  { id: 'skills', label: 'Skills', icon: 'zap', path: '#/soon/skills' },
  { id: 'memory', label: 'Memory', icon: 'brain', path: '#/soon/memory' },
  { id: 'integrations', label: 'Integrations', icon: 'plug', path: '#/soon/integrations' },
] as const;

/** The mockup's sidebar: brand, New chat, the sections, the recent threads, and you. */
export function Sidebar(props: { route: Route; onNewChat: () => void }): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const threads = store.threads().slice(0, 8);
  // one line per conversation: the first line of the request, cut short
  const title = (t: RunSummaryPlus) => {
    const st = state.states[t.runId];
    const text =
      ((st ? requestText(st.input) : '') || t.workflow).split('\n')[0]?.trim() ?? t.workflow;
    return text.length > 34 ? `${text.slice(0, 33).trimEnd()}…` : text;
  };
  const needsYou = state.inbox.length;
  const active = (id: string) =>
    (props.route.name === 'chats' && id === 'chats') ||
    (props.route.name === 'soon' && props.route.section === id);
  return (
    <aside className="side">
      <a className="brand" href="#/">
        <S.Mascot size={30} crop label="Shibaox" />
        shibaox
      </a>
      <S.Button
        variant="secondary"
        icon="plus"
        style={{ justifyContent: 'flex-start', marginBottom: 8 }}
        onClick={props.onNewChat}
      >
        New chat
      </S.Button>
      {SECTIONS.map((s) => (
        <S.NavItem
          key={s.id}
          icon={s.icon}
          label={s.label}
          active={active(s.id)}
          count={s.id === 'chats' && needsYou > 0 ? needsYou : undefined}
          onClick={() => navigate(s.path)}
        />
      ))}
      <div className="grp">Recent</div>
      <div className="recent">
        {threads.map((t) => (
          <S.NavItem
            key={t.runId}
            label={title(t)}
            active={props.route.name === 'thread' && props.route.id === t.runId}
            onClick={() => navigate(`#/t/${encodeURIComponent(t.runId)}`)}
          />
        ))}
      </div>
      <div className="me">
        <S.Avatar kind="user" name={state.settings.name ?? 'You'} size={28} />
        {state.settings.name ?? 'You'}
        <span className="grow" />
        <S.IconButton
          icon="settings"
          label="Settings"
          size="sm"
          onClick={() => navigate('#/settings')}
        />
      </div>
    </aside>
  );
}
