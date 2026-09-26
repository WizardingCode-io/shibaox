import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { Reconnecting } from '../src/component/reconnecting.js';
import { KeysProvider } from '../src/context/keys.js';
import { MotionProvider } from '../src/motion/config.js';
import { ThemeProvider } from '../src/theme/context.js';
import { Dialog, DialogProvider, useDialog } from '../src/ui/dialog.js';
import { Toast, ToastProvider, useToast } from '../src/ui/toast.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function Wrap(props: { children: unknown; onExit?: (c: number) => void }) {
  return (
    <ThemeProvider>
      <MotionProvider enabled={false}>
        <KeysProvider onExit={props.onExit ?? (() => {})}>
          <ToastProvider>
            <DialogProvider>
              {props.children as never}
              <Toast />
            </DialogProvider>
          </ToastProvider>
        </KeysProvider>
      </MotionProvider>
    </ThemeProvider>
  );
}

const holder: {
  api?: { dialog: ReturnType<typeof useDialog>; toast: ReturnType<typeof useToast> };
} = {};
function Probe() {
  holder.api = { dialog: useDialog(), toast: useToast() };
  return <text>background text</text>;
}

function probeApi() {
  return holder.api;
}

async function mount() {
  holder.api = undefined;
  const setup = await testRender(
    () => (
      <Wrap>
        <Probe />
      </Wrap>
    ),
    { width: 80, height: 20, exitOnCtrlC: false },
  );
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const api = probeApi();
  if (!api) throw new Error('probe did not mount');
  return { setup, frame, api };
}

test('dialogs stack over the page and esc closes only the top one', async () => {
  const m = await mount();
  try {
    m.api.dialog.open(() => (
      <Dialog title="First" onClose={() => m.api.dialog.close()}>
        <text>first body</text>
      </Dialog>
    ));
    let f = await m.frame();
    expect(f).toContain('first body');
    expect(f).toContain('background text');
    expect(m.api.dialog.depth()).toBe(1);
    m.api.dialog.open(() => (
      <Dialog title="Second" onClose={() => m.api.dialog.close()}>
        <text>second body</text>
      </Dialog>
    ));
    f = await m.frame();
    expect(f).toContain('second body');
    expect(m.api.dialog.depth()).toBe(2);
    await m.setup.mockInput.pressEscape();
    f = await m.frame();
    expect(m.api.dialog.depth()).toBe(1);
    expect(f).not.toContain('second body');
    expect(f).toContain('first body');
    await m.setup.mockInput.pressEscape();
    await m.frame();
    expect(m.api.dialog.depth()).toBe(0);
  } finally {
    m.setup.renderer.destroy();
  }
});

test('toasts queue in the top-right corner, expire and run their action on click', async () => {
  const m = await mount();
  try {
    let ran = 0;
    m.api.toast.show({
      message: 'Run done',
      variant: 'success',
      duration: 200,
      action: { label: 'Open', run: () => ran++ },
    });
    m.api.toast.show({ message: 'Second one', variant: 'info', duration: 200 });
    let f = await m.frame();
    const line = f.split('\n').find((l) => l.includes('Run done')) ?? '';
    expect(line.indexOf('Run done')).toBeGreaterThan(40);
    expect(f).toContain('+1 more');
    expect(f).toContain('› Open');
    const row = f.split('\n').findIndex((l) => l.includes('Run done'));
    await m.setup.mockMouse.click(line.indexOf('Run done') + 2, row);
    await settle();
    expect(ran).toBe(1);
    await m.setup.mockMouse.moveTo(2, 15); // leaving the toast resumes its timer
    f = await m.frame();
    expect(f).toContain('Second one');
    await settle(300);
    f = await m.frame();
    expect(f).not.toContain('Second one');
    expect(m.api.toast.current()).toBeUndefined();
  } finally {
    m.setup.renderer.destroy();
  }
});

test('the reconnecting overlay waits 2 s before covering the page', async () => {
  const [since, setSince] = createSignal<number | undefined>(undefined);
  const setup = await testRender(
    () => (
      <Wrap>
        <text>page</text>
        <Reconnecting since={since} />
      </Wrap>
    ),
    { width: 60, height: 12, exitOnCtrlC: false },
  );
  try {
    setSince(Date.now());
    await settle(500);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain('Connection lost');
    await settle(1700);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('Connection lost');
    setSince(undefined);
    await settle(50);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain('Connection lost');
  } finally {
    setup.renderer.destroy();
  }
});
