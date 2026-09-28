// A small port of opentui-spinner (MIT, https://github.com/…/opentui-spinner): the package
// pins its OpenTUI peers to 0.3, which an npm install resolves to a second OpenTUI copy
// next to ours and the dashboard refuses to start. What we use fits in this file.
import {
  type ColorInput,
  type OptimizedBuffer,
  parseColor,
  Renderable,
  type RenderableOptions,
  type RenderContext,
  type RGBA,
  resolveRenderLib,
} from '@opentui/core';
import { extend } from '@opentui/solid/components';

export interface SpinnerOptions extends RenderableOptions<SpinnerRenderable> {
  frames?: string[];
  /** Milliseconds per frame (16–1000). */
  interval?: number;
  autoplay?: boolean;
  color?: ColorInput;
  backgroundColor?: ColorInput;
}

const DEFAULT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const clampInterval = (ms: number) => Math.min(1000, Math.max(1000 / 60, ms));
type Encoded = ReturnType<ReturnType<typeof resolveRenderLib>['encodeUnicode']>;

/** One cell (or a few) that cycles through `frames` every `interval` ms while visible. */
export class SpinnerRenderable extends Renderable {
  private _frames: string[];
  private _interval: number;
  private _running = false;
  private _index = 0;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _color: RGBA;
  private _background: RGBA;
  private readonly _lib = resolveRenderLib();
  private _encoded = new Map<string, NonNullable<Encoded>>();

  constructor(ctx: RenderContext, options: SpinnerOptions) {
    super(ctx, options);
    this._frames = options.frames?.length ? options.frames : DEFAULT_FRAMES;
    this._interval = clampInterval(options.interval ?? 80);
    this._color = parseColor(options.color ?? 'white');
    this._background = parseColor(options.backgroundColor ?? 'transparent');
    this.height = 1;
    this.encode();
    if (options.autoplay ?? true) this.start();
  }

  private encode(): void {
    let width = 0;
    for (const f of this._frames) {
      const e = this._encoded.get(f) ?? this._lib.encodeUnicode(f, this.ctx.widthMethod);
      if (!e) continue;
      this._encoded.set(f, e);
      width = Math.max(
        width,
        e.data.reduce((n: number, c: { width: number }) => n + c.width, 0),
      );
    }
    this.width = width;
  }
  private free(): void {
    for (const e of this._encoded.values()) this._lib.freeUnicode(e);
    this._encoded.clear();
  }
  private arm(): void {
    this.disarm();
    if (!this._running || !this.visible) return;
    this._timer = setInterval(() => {
      if (this.isDestroyed) return this.disarm();
      this._index = (this._index + 1) % this._frames.length;
      this.requestRender();
    }, this._interval);
    this._timer.unref?.();
  }
  private disarm(): void {
    if (this._timer !== undefined) clearInterval(this._timer);
    this._timer = undefined;
  }

  get frames(): string[] {
    return this._frames;
  }
  set frames(value: string[]) {
    const next = value.length ? value : DEFAULT_FRAMES;
    if (next.length === this._frames.length && next.every((f, i) => f === this._frames[i])) return;
    this.free();
    this._frames = next;
    this._index = 0;
    this.encode();
    this.requestRender();
  }
  get interval(): number {
    return this._interval;
  }
  set interval(ms: number) {
    this._interval = clampInterval(ms);
    this.arm();
  }
  get color(): RGBA {
    return this._color;
  }
  set color(value: ColorInput) {
    this._color = parseColor(value);
    this.requestRender();
  }
  get backgroundColor(): RGBA {
    return this._background;
  }
  set backgroundColor(value: ColorInput) {
    this._background = parseColor(value);
    this.requestRender();
  }
  get autoplay(): boolean {
    return this._running;
  }
  set autoplay(value: boolean) {
    if (value) this.start();
    else this.stop();
  }
  override get visible(): boolean {
    return super.visible;
  }
  override set visible(value: boolean) {
    super.visible = value;
    this.arm();
  }
  start(): void {
    if (this._running || this.isDestroyed) return;
    this._running = true;
    this.arm();
  }
  stop(): void {
    this._running = false;
    this.disarm();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible) return;
    const frame = this._frames[this._index];
    const e = frame ? this._encoded.get(frame) : undefined;
    if (!e) return;
    let x = this.x;
    for (const c of e.data) {
      buffer.drawChar(c.char, x, this.y, this._color, this._background);
      x += c.width;
    }
  }
  protected override destroySelf(): void {
    this.stop();
    this.free();
    super.destroySelf();
  }
}

declare module '@opentui/solid' {
  interface OpenTUIComponents {
    spinner: typeof SpinnerRenderable;
  }
}

let registered = false;
/** Makes `<spinner>` available to the Solid renderer (once). */
export function registerSpinner(): void {
  if (registered) return;
  registered = true;
  extend({ spinner: SpinnerRenderable });
}
