// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
import { RGBA } from '@opentui/core';
import { type Accessor, type JSX, Show } from 'solid-js';
import { Spinner } from '../motion/spinner.js';
import { useTheme } from '../theme/context.js';
import { createDelayedPresence } from '../ui/delayed-presence.js';

const DELAY_MS = 2000;

/** Covers the page while the daemon has been unreachable for more than two seconds. */
export function Reconnecting(props: { since: Accessor<number | undefined> }): JSX.Element {
  const theme = useTheme();
  const visible = createDelayedPresence(props.since, DELAY_MS);
  return (
    <Show when={visible()}>
      <box
        position="absolute"
        zIndex={10_000}
        top={0}
        right={0}
        bottom={0}
        left={0}
        backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
        alignItems="center"
        justifyContent="center"
      >
        <box
          width={48}
          maxWidth="90%"
          flexDirection="column"
          backgroundColor={theme.background.raised.base}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          gap={1}
        >
          <Spinner color={theme.text.base}>Connection lost…</Spinner>
          <text fg={theme.text.muted}>Reconnecting to the daemon automatically.</text>
        </box>
      </box>
    </Show>
  );
}
