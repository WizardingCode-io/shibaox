import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { ThemeProvider, useSyntax, useTheme } from '../src/theme/context.js';

function Probe() {
  const theme = useTheme();
  const syntax = useSyntax();
  return <text fg={theme.text.base}>{`themed ${syntax ? 'with syntax' : ''}`}</text>;
}

test('ThemeProvider gives components the resolved theme and a syntax style', async () => {
  const setup = await testRender(
    () => (
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    ),
    { width: 40, height: 5 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('themed with syntax');
  } finally {
    setup.renderer.destroy();
  }
});
