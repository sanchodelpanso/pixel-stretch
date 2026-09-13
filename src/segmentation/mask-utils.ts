import type { BBox } from '../types/segmentation';

/**
 * Compute the normalized bounding box of a mask.
 * Returns null if the mask is empty.
 */
export function maskBoundingBox(
  mask: Float32Array,
  width: number,
  height: number,
  threshold = 0.1,
): BBox | null {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;

  return {
    x: minX / width,
    y: minY / height,
    w: (maxX - minX + 1) / width,
    h: (maxY - minY + 1) / height,
  };
}

/**
 * Extract the bounding box of a brush mask (Uint8Array from canvas)
 * and convert to pixel coordinates for SAM box prompt.
 *
 * Returns [x1, y1, x2, y2] in pixel coordinates, or null if empty.
 */
export function brushMaskToBox(
  brushMask: Uint8Array,
  width: number,
  height: number,
  threshold = 32,
): [number, number, number, number] | null {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (brushMask[y * width + x] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;

  // Add small padding
  const pad = Math.max(5, Math.round(Math.max(maxX - minX, maxY - minY) * 0.05));
  return [
    Math.max(0, minX - pad),
    Math.max(0, minY - pad),
    Math.min(width - 1, maxX + pad),
    Math.min(height - 1, maxY + pad),
  ];
}

/**
 * Resize a Float32Array mask to target dimensions using bilinear interpolation.
 */
export function resizeMask(
  mask: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  if (srcW === dstW && srcH === dstH) return mask;

  const result = new Float32Array(dstW * dstH);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const srcY = Math.max(0, Math.min(srcH - 1, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const fy = srcY - y0;

    for (let x = 0; x < dstW; x++) {
      const srcX = Math.max(0, Math.min(srcW - 1, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const fx = srcX - x0;

      const v00 = mask[y0 * srcW + x0];
      const v10 = mask[y0 * srcW + x1];
      const v01 = mask[y1 * srcW + x0];
      const v11 = mask[y1 * srcW + x1];

      result[y * dstW + x] =
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx * fy;
    }
  }

  return result;
}
