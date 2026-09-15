/**
 * The "pixel dissolve" stretch style.
 *
 * Instead of every sampled colour running smoothly to the far end, the row is
 * averaged into square blocks and each block becomes a streak made of cells:
 * short near the sample line and longer further out, each cell's colour
 * nudged towards a neighbouring streak and in brightness. Streaks reach
 * different distances, and their far ends break up into gaps, so the band
 * dissolves into ragged, blocky light rather than ending in a straight edge.
 *
 * Everything is driven by a hash of the streak and cell index, so the same
 * band always renders the same way.
 */

export interface PixelStreakOptions {
  /** Streak thickness across the band, in band pixels. */
  blockSize: number;
  /** 0 = every streak reaches the far end unbroken; 1 = very ragged and broken. */
  scatter: number;
  /**
   * 0 = every streak starts right at the sample line; 1 = starts staggered and
   * broken into scattered blocks, so that end dissolves too.
   */
  startScatter?: number;
  /** 0 = crisp blocks; 1 = edges feathered by about half a block. */
  softness?: number;
}

interface StreakColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PixelCell {
  x: number;
  y: number;
  width: number;
  height: number;
  r: number;
  g: number;
  b: number;
  /** 0–1. */
  a: number;
}

export const DEFAULT_PIXEL_SIZE = 8;
export const DEFAULT_PIXEL_SCATTER = 0.5;
export const MIN_PIXEL_SIZE = 2;
export const MAX_PIXEL_SIZE = 64;
export const DEFAULT_PIXEL_START_SCATTER = 0;
export const DEFAULT_PIXEL_SOFTNESS = 0;

/** Keeps a very wide band from generating more streaks than are worth drawing. */
const MAX_STREAKS = 600;

/** Deterministic 0–1 noise for a streak and a cell slot. */
function hash(streak: number, slot: number): number {
  let h = Math.imul(streak | 0, 374761393) ^ Math.imul(slot | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Lay out the cells for a band `height` long whose sampled `row` (straight-alpha
 * RGBA, `columns` wide) runs across it. Cells never overlap and stay inside
 * `columns × height`; gaps are simply absent.
 */
export function pixelStreakCells(
  row: Uint8ClampedArray,
  columns: number,
  height: number,
  options: PixelStreakOptions,
): PixelCell[] {
  if (columns < 1 || height < 1) return [];
  const block = Math.max(MIN_PIXEL_SIZE, Math.round(options.blockSize), Math.ceil(columns / MAX_STREAKS));
  const scatter = Math.max(0, Math.min(1, options.scatter));
  const startScatter = Math.max(0, Math.min(1, options.startScatter ?? 0));

  const streaks = Math.ceil(columns / block);

  // Each streak's colour is its block's premultiplied average.
  const colors = Array.from({ length: streaks }, (_, k): StreakColor => {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    const end = Math.min(columns, (k + 1) * block);
    for (let i = k * block; i < end; i++) {
      const alpha = row[i * 4 + 3] / 255;
      r += row[i * 4] * alpha;
      g += row[i * 4 + 1] * alpha;
      b += row[i * 4 + 2] * alpha;
      a += alpha;
    }
    const n = end - k * block;
    return a > 0 ? { r: r / a, g: g / a, b: b / a, a: a / n } : { r: 0, g: 0, b: 0, a: 0 };
  });

  const cells: PixelCell[] = [];
  for (let k = 0; k < streaks; k++) {
    const base = colors[k];
    if (base.a <= 1 / 255) continue;
    const x = k * block;
    const width = Math.min(block, columns - x);

    // Neighbouring reaches are related, so the far edge undulates instead of being pure noise.
    const noise = 0.5 * hash(k, 0) + 0.25 * (hash(k - 1, 0) + hash(k + 1, 0));
    const reach = height * (1 - scatter * 0.85 * noise);
    // Where the far end starts breaking up into gaps.
    const breakFrom = reach * (1 - 0.35 * scatter);
    // A ragged start: streaks begin at related, staggered distances, and the
    // stretch just after that breaks up into scattered blocks.
    const startNoise = 0.5 * hash(k, 3) + 0.25 * (hash(k - 1, 3) + hash(k + 1, 3));
    const start = Math.min(reach, height * 0.3 * startScatter * startNoise);
    const settleAt = start + height * 0.3 * startScatter;

    let y = start;
    for (let cell = 0; y < reach; cell++) {
      const progress = y / height;
      // Cells lengthen away from the sample line: blocky near it, streaky far out.
      const length = Math.max(1, block * (1 + 1.5 * hash(k, 2 * cell + 1) + 6 * progress * (0.4 + hash(k, 2 * cell + 2))));
      const cellHeight = Math.min(length, reach - y);

      const endBroken = y > breakFrom ? (y - breakFrom) / Math.max(1, reach - breakFrom) : 0;
      const startBroken = y < settleAt ? 1 - (y - start) / Math.max(1, settleAt - start) : 0;
      const brokenness = Math.max(endBroken, startBroken);
      const dropped = hash(k + 7919, cell) < brokenness * 0.75;
      if (!dropped) {
        // Borrow some colour from a neighbouring streak and jitter the brightness.
        const side = hash(k, cell + 104729) < 0.5 ? -1 : 1;
        const neighbour = colors[k + side] && colors[k + side].a > 0 ? colors[k + side] : base;
        const borrow = hash(k, cell + 15485863) * (0.15 + 0.35 * scatter) * Math.min(1, progress * 3);
        const light = 1 + (hash(k, cell + 32452843) - 0.5) * 0.18;
        cells.push({
          x,
          y,
          width,
          height: cellHeight,
          r: Math.min(255, (base.r + (neighbour.r - base.r) * borrow) * light),
          g: Math.min(255, (base.g + (neighbour.g - base.g) * borrow) * light),
          b: Math.min(255, (base.b + (neighbour.b - base.b) * borrow) * light),
          a: base.a,
        });
      }
      y += length;
    }
  }
  return cells;
}

/**
 * Paint the pixel-dissolve band into a context sized `columns × height`, then
 * feather the block edges when `softness` asks for it.
 */
export function drawPixelStreaks(
  ctx: CanvasRenderingContext2D,
  row: Uint8ClampedArray,
  columns: number,
  height: number,
  options: PixelStreakOptions,
): void {
  for (const cell of pixelStreakCells(row, columns, height, options)) {
    ctx.fillStyle = `rgba(${Math.round(cell.r)},${Math.round(cell.g)},${Math.round(cell.b)},${cell.a})`;
    ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
  }

  const softness = Math.max(0, Math.min(1, options.softness ?? 0));
  const radius = Math.round(softness * Math.max(MIN_PIXEL_SIZE, options.blockSize) * 0.5);
  if (radius < 1) return;
  const image = ctx.getImageData(0, 0, columns, height);
  softenPixels(image.data, columns, height, radius);
  ctx.putImageData(image, 0, 0);
}

/**
 * Feather RGBA pixels in place: two passes of a separable box blur of `radius`,
 * which is close to a Gaussian. Colour is premultiplied while blurring so
 * transparent gaps don't bleed dark fringes, and outside the image counts as
 * transparent, so the band's own edges soften too. Runs in time proportional
 * to the pixel count whatever the radius.
 */
export function softenPixels(data: Uint8ClampedArray, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.round(radius));
  if (r < 1 || width < 1 || height < 1) return;

  const premultiplied = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    premultiplied[i] = data[i] * a;
    premultiplied[i + 1] = data[i + 1] * a;
    premultiplied[i + 2] = data[i + 2] * a;
    premultiplied[i + 3] = data[i + 3];
  }

  const line = new Float32Array(Math.max(width, height) * 4);
  const span = 2 * r + 1;
  /** One box pass along a line of `count` pixels starting at `offset`, stepping `stride`. */
  const pass = (offset: number, stride: number, count: number) => {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) {
        if (i >= 0 && i < count) sum += premultiplied[offset + i * stride + c];
      }
      for (let i = 0; i < count; i++) {
        line[i * 4 + c] = sum / span;
        const leaving = i - r;
        const entering = i + r + 1;
        if (leaving >= 0) sum -= premultiplied[offset + leaving * stride + c];
        if (entering < count) sum += premultiplied[offset + entering * stride + c];
      }
    }
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 4; c++) premultiplied[offset + i * stride + c] = line[i * 4 + c];
    }
  };

  for (let repeat = 0; repeat < 2; repeat++) {
    for (let y = 0; y < height; y++) pass(y * width * 4, 4, width);
    for (let x = 0; x < width; x++) pass(x * 4, width * 4, height);
  }

  for (let i = 0; i < data.length; i += 4) {
    const a = premultiplied[i + 3];
    const weight = a > 0 ? 255 / a : 0;
    data[i] = premultiplied[i] * weight;
    data[i + 1] = premultiplied[i + 1] * weight;
    data[i + 2] = premultiplied[i + 2] * weight;
    data[i + 3] = a;
  }
}
