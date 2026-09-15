/**
 * The "motion" stretch style: soft streaks of uneven length.
 *
 * Every column of the sampled row runs out its own distance. Neighbouring
 * columns reach similar distances — smooth noise at a broad and a fine scale —
 * so the far edge undulates in soft tongues rather than jagged noise, and each
 * streak's end fades out gradually. Columns are blurred into each other a
 * little, so the streaks read as motion rather than hard stripes. An optional
 * fade-in at the sample line lets a band laid over its subject dissolve it into
 * the streaks.
 *
 * Everything is driven by a hash of the column, so a band always renders the
 * same way.
 */

export interface MotionStreakOptions {
  /** 0 = every streak reaches the far end; 1 = lengths vary widely. */
  scatter: number;
  /** 0 = crisp streaks with short fades; 1 = long soft fades and streaks blurred together. */
  softness: number;
  /** 0 = full strength at the sample line; 1 = fades in over most of the band. */
  fadeIn: number;
}

export const DEFAULT_MOTION_SCATTER = 0.6;
export const DEFAULT_MOTION_SOFTNESS = 0.5;
export const DEFAULT_MOTION_FADE_IN = 0;

/** Most blur across streaks, in band pixels, at full softness. */
const MAX_CROSS_BLUR = 3;
/** Broad and fine noise scales, in columns. */
const BROAD = 48;
const FINE = 9;

function hash(index: number, salt: number): number {
  let h = Math.imul(index | 0, 374761393) ^ Math.imul(salt, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Smooth 0–1 value noise over columns, with lattice points `spacing` apart. */
export function valueNoise(column: number, spacing: number, salt: number): number {
  const position = column / spacing;
  const cell = Math.floor(position);
  const t = smoothstep(position - cell);
  return hash(cell, salt) * (1 - t) + hash(cell + 1, salt) * t;
}

/** Blur a straight-alpha RGBA row across its columns, premultiplied so gaps don't darken. */
function blurRow(row: Uint8ClampedArray, columns: number, radius: number): Float32Array {
  const premultiplied = new Float32Array(columns * 4);
  for (let i = 0; i < columns; i++) {
    const a = row[i * 4 + 3] / 255;
    premultiplied[i * 4] = row[i * 4] * a;
    premultiplied[i * 4 + 1] = row[i * 4 + 1] * a;
    premultiplied[i * 4 + 2] = row[i * 4 + 2] * a;
    premultiplied[i * 4 + 3] = row[i * 4 + 3];
  }
  if (radius < 1) return premultiplied;

  const out = new Float32Array(columns * 4);
  for (let i = 0; i < columns; i++) {
    // Edge columns average over what's there, so the band's sides don't fade.
    const from = Math.max(0, i - radius);
    const to = Math.min(columns - 1, i + radius);
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let j = from; j <= to; j++) sum += premultiplied[j * 4 + c];
      out[i * 4 + c] = sum / (to - from + 1);
    }
  }
  return out;
}

/**
 * The motion band's pixels, `columns × height` straight-alpha RGBA, for a
 * sampled `row` (straight-alpha RGBA, `columns` wide) running across it.
 */
export function motionStreakPixels(
  row: Uint8ClampedArray,
  columns: number,
  height: number,
  options: MotionStreakOptions,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(Math.max(0, columns * height * 4));
  if (columns < 1 || height < 1) return out;

  const scatter = Math.max(0, Math.min(1, options.scatter));
  const softness = Math.max(0, Math.min(1, options.softness));
  const fadeLength = Math.max(0, Math.min(1, options.fadeIn)) * height * 0.6;
  const colors = blurRow(row, columns, Math.round(softness * MAX_CROSS_BLUR));

  for (let x = 0; x < columns; x++) {
    const a = colors[x * 4 + 3];
    if (a <= 0) continue;
    const weight = 255 / a;
    const r = colors[x * 4] * weight;
    const g = colors[x * 4 + 1] * weight;
    const b = colors[x * 4 + 2] * weight;

    const noise = 0.65 * valueNoise(x, BROAD, 1) + 0.35 * valueNoise(x, FINE, 2);
    const reach = height * (1 - scatter * 0.9 * noise);
    const tail = Math.max(1, reach * (0.08 + 0.6 * softness));
    const solidUntil = reach - tail;

    for (let y = 0; y < Math.min(height, Math.ceil(reach)); y++) {
      const centre = y + 0.5;
      let alpha = centre <= solidUntil ? 1 : smoothstep(Math.max(0, Math.min(1, (reach - centre) / tail)));
      if (fadeLength > 0 && centre < fadeLength) alpha *= smoothstep(centre / fadeLength);
      if (alpha <= 0) continue;
      const i = (y * columns + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = a * alpha;
    }
  }
  return out;
}
