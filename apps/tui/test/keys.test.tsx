import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal, Show } from 'solid-js';
import { KeysProvider, type Scope, useKeys } from '../src/context/keys.js';

const settle = () => new Promise((r) => setTimeout(r, 20));

function Layer(props: { scope: Scope; log: string[]; consume?: string[] }) {
  useKeys(props.scope, (key) => {
    props.log.push(`${props.scope}:${key.name}`);
    return props.consume?.includes(key.name) ?? false;
  });
  return <text>{props.scope}</text>;
}

test('scopes: a dialog is modal, prompt precedes pane precedes global, ctrl+q always exits', async () => {
  const log: string[] = [];
  const exits: number[] = [];
  const [dialog, setDialog] = createSignal(false);
  const setup = await testRender(
    () => (
      <KeysProvider onExit={(c) => exits.push(c)}>
        <box flexDirection="column">
          <Layer scope="global" log={log} />
          <Layer scope="pane" log={log} consume={['j']} />
          <Layer scope="prompt" log={log} consume={['x', 'c']} />
          <Show when={dialog()}>
            <Layer scope="dialog" log={log} />
          </Show>
        </box>
      </KeysProvider>
    ),
    { width: 40, height: 6 },
  );
  try {
    await setup.mockInput.pressKey('j');
    await settle();
    expect(log).toEqual(['prompt:j', 'pane:j']); // pane consumed j; global never saw it
    log.length = 0;
    await setup.mockInput.pressKey('?');
    await settle();
    expect(log).toEqual(['prompt:?', 'pane:?', 'global:?']);
    log.length = 0;
    await setup.mockInput.pressKey('x');
    await settle();
    expect(log).toEqual(['prompt:x']);
    log.length = 0;
    setDialog(true);
    await settle();
    await setup.renderOnce();
    await setup.mockInput.pressKey('j');
    await settle();
    expect(log).toEqual(['dialog:j']);
    log.length = 0;
    await setup.mockInput.pressKey('q', { ctrl: true });
    await settle();
    expect(exits).toEqual([0]);
    // ctrl+c: the prompt consumes it (clears text) so the app stays
    await setup.mockInput.pressKey('c', { ctrl: true });
    await settle();
    expect(exits).toEqual([0]);
    setDialog(false);
    await settle();
    await setup.renderOnce();
    await setup.mockInput.pressKey('c', { ctrl: true });
    await settle();
    expect(exits).toEqual([0]); // still consumed by the prompt layer
  } finally {
    setup.renderer.destroy();
  }
});

test('ctrl+c exits when no prompt consumes it', async () => {
  const exits: number[] = [];
  const setup = await testRender(
    () => (
      <KeysProvider onExit={(c) => exits.push(c)}>
        <Layer scope="pane" log={[]} />
      </KeysProvider>
    ),
    { width: 40, height: 6 },
  );
  try {
    await setup.mockInput.pressKey('c', { ctrl: true });
    await settle();
    expect(exits).toEqual([0]);
  } finally {
    setup.renderer.destroy();
  }
});
