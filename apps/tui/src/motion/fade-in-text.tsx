// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
import { type OptimizedBuffer, type RenderContext, RGBA, type TextOptions } from '@opentui/core';
import { extend, type JSX } from '@opentui/solid';
import { splitProps } from 'solid-js';
import { useMotion } from './config.js';
import { MaskedTextRenderable } from './masked-text.js';
import { coast, smootherstep } from './pulse.js';

type FadeInTextOptions = TextOptions & { backdrop?: RGBA; enabled?: boolean };

const DURATION = 200;
const FEATHER = 8;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

class FadeInTextRenderable extends MaskedTextRenderable {
  private _backdrop = RGBA.defaultBackground();
  private _enabled = true;
  private elapsed = 0;

  constructor(ctx: RenderContext, options: FadeInTextOptions) {
    super(ctx, options);
    this.matrix[15] = 1;
    this.updateBackdrop();
    if (options.backdrop) this.backdrop = options.backdrop;
    if (options.enabled === false) this.enabled = false;
    this.live = this._enabled;
  }

  set backdrop(value: RGBA) {
    if (value.equals(this._backdrop)) return;
    this._backdrop = value;
    this.updateBackdrop();
    this.requestRender();
  }

  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    this.live = value && this.elapsed < DURATION;
    this.requestRender();
  }

  private updateBackdrop() {
    this.matrix[3] = this._backdrop.r;
    this.matrix[7] = this._backdrop.g;
    this.matrix[11] = this._backdrop.b;
  }

  override render(buffer: OptimizedBuffer, deltaTime: number): void {
    if (!this._enabled || this.elapsed >= DURATION) {
      super.render(buffer, deltaTime);
      return;
    }
    if (
      !this.visible ||
      this.isDestroyed ||
      !Number.isFinite(this.width) ||
      this.width <= 0 ||
      this.height <= 0
    )
      return;
    this.elapsed = Math.min(DURATION, this.elapsed + deltaTime);
    this.renderMasked(buffer, 1, (end) => {
      const progress = this.elapsed / DURATION;
      const front = -FEATHER + coast(progress) * (end + FEATHER * 2);
      return (column) => 1 - smootherstep(clamp((front - column) / FEATHER));
    });
    if (this.elapsed >= DURATION) this.live = false;
  }
}

extend({ fade_in_text: FadeInTextRenderable });

declare module '@opentui/solid' {
  interface OpenTUIComponents {
    fade_in_text: typeof FadeInTextRenderable;
  }
}

type Props = Omit<JSX.IntrinsicElements['text'], 'ref'> & { animate?: boolean; backdrop?: RGBA };

/** Text that sweeps in from the left over 200 ms when it first appears. */
export function FadeInText(props: Props): JSX.Element {
  const motion = useMotion();
  const [local, text] = splitProps(props, ['animate', 'backdrop']);
  return (
    <fade_in_text
      {...text}
      backdrop={local.backdrop}
      enabled={(local.animate ?? true) && motion()}
    />
  );
}
