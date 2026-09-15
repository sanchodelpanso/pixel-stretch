/**
 * Helpers for the grid texture, and for drawing band textures through the cell
 * mesh without seams.
 */

/** How a grid texture treats the stretch: cut lines into it, or keep only the lines. */
export type GridStyle = 'cut' | 'lines';

export interface GridOptions {
  /** 0–1. In `cut`, how strongly the lines apply; in `lines`, how opaque the lines are. */
  strength: number;
  /** Cell size in band pixels, line to line. */
  size: number;
  style: GridStyle;
  /** Cut lines' colour as `#rrggbb`, or undefined for see-through cuts. Grid-only lines always keep the stretch. */
  color?: string;
}

export const DEFAULT_GRID_SIZE = 8;
export const MIN_GRID_SIZE = 3;
export const MAX_GRID_SIZE = 64;

/** Line thickness for a cell size: a pixel for fine grids, thicker as cells grow. */
export function gridLineWidth(size: number): number {
  return Math.max(1, Math.round(size / 8));
}

/** Whether a band pixel lies on a grid line, across or along the band. */
export function onGridLine(column: number, row: number, size: number): boolean {
  const cell = Math.max(1, Math.round(size));
  const width = gridLineWidth(cell);
  const across = ((Math.floor(column) % cell) + cell) % cell;
  const along = ((Math.floor(row) % cell) + cell) % cell;
  return across >= cell - width || along >= cell - width;
}

/**
 * What the grid does to one band pixel: `keep` multiplies the stretch's
 * opacity, and `paint` is how much of the grid colour to mix into it.
 *
 * - cut, no colour: lines turn see-through by `strength`.
 * - cut, colour: lines are painted in the colour by `strength`.
 * - lines: cells are fully transparent; lines carry the stretch's own sampled
 *   colours, `strength` opaque.
 */
export function gridEffect(column: number, row: number, options: GridOptions): { keep: number; paint: number } {
  const strength = Math.max(0, Math.min(1, options.strength));
  if (strength <= 0) return { keep: 1, paint: 0 };
  const line = onGridLine(column, row, options.size);
  if (options.style === 'lines') return { keep: line ? strength : 0, paint: 0 };
  if (!line) return { keep: 1, paint: 0 };
  return options.color ? { keep: 1, paint: strength } : { keep: 1 - strength, paint: 0 };
}

/** `#rrggbb` to channels, or null when it isn't one. */
export function parseHexColor(value: string | undefined): [number, number, number] | null {
  const match = value ? /^#([0-9a-f]{6})$/i.exec(value) : null;
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Split straight-alpha RGBA into two opaque images: its colour, and its alpha
 * as grey. Drawing overlapping mesh cells of opaque images leaves no seams,
 * where translucent ones would double up along every cell border.
 *
 * Fully transparent pixels carry no colour of their own, so they borrow the
 * nearest coloured pixel along their row — or, for an empty row, their column
 * — keeping smoothing at the texture's soft edges from pulling in black.
 */
export function splitColorAndAlpha(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { color: Uint8ClampedArray; alpha: Uint8ClampedArray } {
  const color = new Uint8ClampedArray(data.length);
  const alpha = new Uint8ClampedArray(data.length);
  const filled = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    let last = -1;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      alpha[i * 4] = alpha[i * 4 + 1] = alpha[i * 4 + 2] = data[i * 4 + 3];
      alpha[i * 4 + 3] = 255;
      color[i * 4 + 3] = 255;
      if (data[i * 4 + 3] > 0) {
        color[i * 4] = data[i * 4];
        color[i * 4 + 1] = data[i * 4 + 1];
        color[i * 4 + 2] = data[i * 4 + 2];
        filled[i] = 1;
        // Back-fill the gap before the first coloured pixel of the row.
        if (last < 0) {
          for (let j = y * width; j < i; j++) {
            color.set(color.subarray(i * 4, i * 4 + 3), j * 4);
            filled[j] = 1;
          }
        }
        last = i;
      } else if (last >= 0) {
        color.set(color.subarray(last * 4, last * 4 + 3), i * 4);
        filled[i] = 1;
      }
    }
  }

  // Rows with no colour at all copy the nearest filled row.
  for (let pass = 0; pass < 2; pass++) {
    const rows = pass === 0 ? Array.from({ length: height }, (_, y) => y) : Array.from({ length: height }, (_, y) => height - 1 - y);
    let source = -1;
    for (const y of rows) {
      if (filled[y * width]) {
        source = y;
      } else if (source >= 0) {
        color.copyWithin(y * width * 4, source * width * 4, (source + 1) * width * 4);
        for (let x = 0; x < width; x++) filled[y * width + x] = 1;
      }
    }
  }
  return { color, alpha };
}
