// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
import { type OptimizedBuffer, type RenderContext, RGBA, type TextOptions } from '@opentui/core';
import { extend, type JSX } from '@opentui/solid';
import { splitProps } from 'solid-js';
import { useMotion } from './config.js';
import { MaskedTextRenderable } from './masked-text.js';
import { coast, intensityAt } from './pulse.js';

type ShimmerTextOptions = TextOptions & { shimmer: RGBA; enabled?: boolean };

const DURATION = 1200;

class ShimmerTextRenderable extends MaskedTextRenderable {
  private _shimmer = RGBA.defaultForeground();
  private _enabled = true;
  private elapsed = 0;

  constructor(ctx: RenderContext, options: ShimmerTextOptions) {
    super(ctx, options);
    this.matrix[15] = 1;
    if (options.shimmer) this.shimmer = options.shimmer;
    if (options.enabled === false) this.enabled = false;
    this.live = this._enabled;
  }

  set shimmer(value: RGBA) {
    if (value.equals(this._shimmer)) return;
    this._shimmer = value;
    this.matrix[3] = value.r;
    this.matrix[7] = value.g;
    this.matrix[11] = value.b;
    this.requestRender();
  }

  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    this.live = value;
    this.requestRender();
  }

  override render(buffer: OptimizedBuffer, deltaTime: number): void {
    if (!this._enabled) return super.render(buffer, deltaTime);
    if (
      !this.visible ||
      this.isDestroyed ||
      !Number.isFinite(this.width) ||
      this.width <= 0 ||
      this.height <= 0
    )
      return;
    this.elapsed = (this.elapsed + deltaTime) % DURATION;
    this.renderMasked(buffer, 0, (end) => {
      const front = -4 + coast(this.elapsed / DURATION) * (end + 22);
      return (column) => intensityAt(column, front, 4, 18);
    });
  }
}

extend({ shimmer_text: ShimmerTextRenderable });

declare module '@opentui/solid' {
  interface OpenTUIComponents {
    shimmer_text: typeof ShimmerTextRenderable;
  }
}

type Props = Omit<JSX.IntrinsicElements['text'], 'ref'> & { shimmer: RGBA };

/** Text with a light sweep travelling across it (the "working" affordance). */
export function ShimmerText(props: Props): JSX.Element {
  const motion = useMotion();
  const [local, text] = splitProps(props, ['shimmer']);
  return <shimmer_text {...text} shimmer={local.shimmer} enabled={motion()} />;
}
