import { ds } from '../ds.js';

const WORDS: Record<string, string> = {
  scheduled: 'Routines land here next: what the daemon does on its own, and when.',
  skills: 'The workflows and skills of your org, ready to run.',
  memory: 'What Shibaox remembers about the project.',
  integrations: 'MCP servers, providers and keys.',
};

export function SoonScreen(props: { section: string }): JSX.Element {
  const S = ds();
  return (
    <main className="main">
      <div className="top">
        <h2>
          {props.section[0]?.toUpperCase()}
          {props.section.slice(1)}
        </h2>
      </div>
      <div className="empty">
        <S.Mascot mood="sleeping" size={96} />
        <h2>Coming soon</h2>
        <p>{WORDS[props.section] ?? 'On its way.'} Until then: the shibaox CLI.</p>
      </div>
    </main>
  );
}
