import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { MotionProvider } from '../src/motion/config.js';
import { FadeInText } from '../src/motion/fade-in-text.js';
import { WORK_SPINNERS } from '../src/motion/one-cell-motion.js';
import { ShimmerText } from '../src/motion/shimmer-text.js';
import { OneCellSpinner, Spinner } from '../src/motion/spinner.js';
import { ThemeProvider, useTheme } from '../src/theme/context.js';

function Scene() {
  const theme = useTheme();
  return (
    <box flexDirection="column">
      <ShimmerText fg={theme.text.muted} shimmer={theme.text.base}>
        Working
      </ShimmerText>
      <FadeInText fg={theme.text.base}>fresh line</FadeInText>
      <box flexDirection="row">
        <Spinner color={theme.text.muted}>loading</Spinner>
      </box>
      <box flexDirection="row">
        <OneCellSpinner
          animation={WORK_SPINNERS['block-soft-sweep']}
          color={theme.text.feedback.running}
        />
        <text>{' node'}</text>
      </box>
    </box>
  );
}

async function frameWith(motion: boolean) {
  const setup = await testRender(
    () => (
      <ThemeProvider>
        <MotionProvider enabled={motion}>
          <Scene />
        </MotionProvider>
      </ThemeProvider>
    ),
    { width: 40, height: 8, exitOnCtrlC: false },
  );
  try {
    await new Promise((r) => setTimeout(r, 60));
    await setup.renderOnce();
    return setup.captureCharFrame();
  } finally {
    setup.renderer.destroy();
  }
}

test('shimmer and fade-in draw their text with motion on and off', async () => {
  for (const motion of [true, false]) {
    const f = await frameWith(motion);
    expect(f).toContain('Working');
    expect(f).toContain('fresh line');
  }
});

test('spinners fall back to still glyphs without motion', async () => {
  const f = await frameWith(false);
  expect(f).toContain('⋯ loading');
  expect(f).toContain('▪ node');
  const on = await frameWith(true);
  expect(on).not.toContain('⋯ loading');
  expect(on).toContain('loading');
});
