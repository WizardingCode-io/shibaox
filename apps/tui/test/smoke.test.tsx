import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { App } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('the app draws the daemon title and ctrl+q exits with 0', async () => {
  const client = new FakeDaemonClient();
  const exits: number[] = [];
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home="/tmp/shx-home"
        env={{ SHIBAOX_NO_MOTION: '1' }}
        onExit={(c) => exits.push(c)}
      />
    ),
    { width: 80, height: 20 },
  );
  try {
    await settle();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('shibaox · daemon 0.0.1');
    await setup.mockInput.pressKey('q', { ctrl: true });
    await settle();
    expect(exits).toEqual([0]);
  } finally {
    setup.renderer.destroy();
  }
});
