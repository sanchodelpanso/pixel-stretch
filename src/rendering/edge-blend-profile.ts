import { valueNoise } from './motion-streaks.ts';

/** How far the start of the melt wanders across streaks, as a fraction of the blend length. */
const START_WANDER = 0.8;
/** How quickly, as a fraction of the blend length, the subject hands over to its smear. */
const SWAP_RAMP = 0.25;
/** Band sides feather over this fraction of its width, so the melt has no cut line. */
const SIDE_FEATHER = 0.06;

export const smoothstep = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

/**
 * How much of the subject gives way to its smear at column `x` (of `columns`)
 * and `y` pixels out from the sample line, 0–1. Nothing at the line; rising
 * quickly from a start that wanders smoothly across the streaks, so the object
 * melts in soft tongues; feathered at the band's two sides.
 */
export function edgeBlendAmount(x: number, y: number, columns: number, length: number): number {
  if (length <= 0) return 0;
  const { wander, side } = blendColumn(x, columns, length);
  return smoothstep((y - wander) / (length * SWAP_RAMP)) * side;
}

/** The per-streak part of the blend: where its melt starts, and its side feather. */
export function blendColumn(x: number, columns: number, length: number): { wander: number; side: number } {
  const wander = length * START_WANDER * (0.65 * valueNoise(x, 48, 11) + 0.35 * valueNoise(x, 9, 12));
  const feather = Math.max(1, columns * SIDE_FEATHER);
  return { wander, side: smoothstep(Math.min(x + 0.5, columns - x - 0.5) / feather) };
}

/** The swap ramp's length for a blend `length`, so callers ramp exactly like `edgeBlendAmount`. */
export const swapRamp = (length: number) => length * SWAP_RAMP;

/** Smear rate at full strength, before the per-fibre variation. */
const MAX_SMEAR_RATE = 1.3;

/**
 * How many pixels behind it each pixel of a streak averages, per pixel past
 * where the melt starts. The blend strength sets it — a hint of softening at a
 * few percent, full streaks at 100% — on a gentle curve so low values stay
 * subtle rather than jumping straight to heavy blur. Varies across streaks at a
 * fine and a broad scale, so neighbouring rows smear by different amounts and
 * read as brushed fibres.
 */
export function smearRate(x: number, strength: number): number {
  const fibre = 0.7 * valueNoise(x, 3, 21) + 0.3 * valueNoise(x, 17, 22);
  const s = Math.max(0, Math.min(1, strength));
  return MAX_SMEAR_RATE * s ** 0.7 * (0.55 + 0.9 * fibre);
}

/**
 * How far from the sample line, as a fraction of the band's length, the melt
 * plays out at a given strength. Never quite zero, so even a light blend has
 * room to start unevenly across the streaks.
 */
export function blendFraction(strength: number): number {
  return 0.1 + 0.5 * Math.max(0, Math.min(1, strength));
}

/**
 * Smear one streak of the subject in place. `samples` holds `count`
 * premultiplied RGBA pixels read along the streak from the sample line
 * outwards. Each pixel becomes the average of the pixels behind it over a
 * window that grows by `rate` for every pixel past `wander`: sharp where the
 * melt starts, dragged ever longer beyond, and thinning out naturally once the
 * window slides past the object's edge.
 */
export function smearStreak(samples: Float32Array, count: number, wander: number, rate: number): Float32Array {
  const prefix = new Float64Array((count + 1) * 4);
  for (let y = 0; y < count; y++) {
    for (let c = 0; c < 4; c++) prefix[(y + 1) * 4 + c] = prefix[y * 4 + c] + samples[y * 4 + c];
  }
  const out = new Float32Array(count * 4);
  for (let y = 0; y < count; y++) {
    const reach = Math.max(0, y - wander) * rate;
    const from = Math.max(0, Math.floor(y - reach));
    const n = y + 1 - from;
    for (let c = 0; c < 4; c++) out[y * 4 + c] = (prefix[(y + 1) * 4 + c] - prefix[from * 4 + c]) / n;
  }
  return out;
}
