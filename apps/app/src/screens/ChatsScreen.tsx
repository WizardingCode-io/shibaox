import { requestText } from '@wizardingcode/shibaox-view';
import { ds } from '../ds.js';
import { clock, money, RUN_STATUS_TONE, RUN_STATUS_WORD } from '../format.js';
import { useAppState, useStore } from '../store/hooks.js';

/** Every conversation, newest activity first. */
export function ChatsScreen(): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const threads = store.threads();
  return (
    <main className="main">
      <div className="top">
        <h2>Chats</h2>
      </div>
      <div className="page sx-scroll">
        {threads.length === 0 ? (
          <div className="empty">
            <h2>No conversations yet</h2>
            <p>Start one with New chat.</p>
          </div>
        ) : null}
        {threads.map((t) => {
          const st = state.states[t.runId];
          return (
            <a
              key={t.runId}
              href={`#/t/${encodeURIComponent(t.runId)}`}
              style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}
            >
              <S.Card
                interactive
                icon="message-square"
                title={(st ? requestText(st.input) : '') || t.workflow}
                description={`${t.project ?? ''}${t.project ? ' · ' : ''}${clock(t.updatedAt) ?? ''} · ${money(t.spentUsd)}`}
                action={
                  <S.Badge tone={RUN_STATUS_TONE[t.status] ?? 'neutral'}>
                    {RUN_STATUS_WORD[t.status] ?? t.status}
                  </S.Badge>
                }
              />
            </a>
          );
        })}
      </div>
    </main>
  );
}
