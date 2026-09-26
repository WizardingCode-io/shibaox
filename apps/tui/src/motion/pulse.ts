// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
// The pulse math of opencode's tab-pulse: shaped sweeps and attack/decay envelopes.
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export const smootherstep = (value: number): number =>
  value * value * value * (value * (value * 6 - 15) + 10);

/** Intensity of a sweep with a soft head ahead of `front` and a long tail behind it. */
export const intensityAt = (index: number, front: number, head: number, tail: number): number => {
  const distance = front - index;
  return distance < 0
    ? smootherstep(clamp(1 + distance / head))
    : smootherstep(clamp(1 - distance / tail));
};

/** Eases the ends of a 0..1 progress so a sweep starts and stops gently. */
export const coast = (value: number): number => {
  const ramp = 0.2;
  if (value < ramp) return (value * value) / (2 * ramp * (1 - ramp));
  if (value > 1 - ramp) return 1 - ((1 - value) * (1 - value)) / (2 * ramp * (1 - ramp));
  return (value - ramp / 2) / (1 - ramp);
};

/** Rise to peak over the attack fraction, then settle to rest over the remainder. */
export const attackDecay = (
  progress: number,
  attack: number,
  peak: number,
  rest: number,
): number =>
  progress < attack
    ? peak * smootherstep(clamp(progress / attack))
    : peak - (peak - rest) * smootherstep(clamp((progress - attack) / (1 - attack)));

const COMPLETION_ATTACK = 0.12;
/** Opacity of the completion pulse over a 0..1 progress. */
export const completionPulseOpacity = (progress: number): number =>
  attackDecay(progress, COMPLETION_ATTACK, 1, 0);
