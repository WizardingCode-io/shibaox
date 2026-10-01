import { ds } from '../ds.js';

const WORDS: Record<string, string> = {
  scheduled: 'Routines land here next: what the daemon does on its own, and when.',
  memory: 'What Shibaox remembers about the project.',
  customize: 'Skills, connectors, plugins, keys and models.',
};

export function SoonScreen(props: { section: string }): JSX.Element {
  const _S = ds();
  return (
    <main className="main">
      <div className="top">
        <h2>
          {props.section[0]?.toUpperCase()}
          {props.section.slice(1)}
        </h2>
      </div>
      <div className="empty">
        <h2>Coming soon</h2>
        <p>{WORDS[props.section] ?? 'On its way.'} Until then: the shibaox CLI.</p>
      </div>
    </main>
  );
}
