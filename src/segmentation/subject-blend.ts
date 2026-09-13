export interface SubjectBlendBorders {
  left: boolean;
  top: boolean;
  right: boolean;
  bottom: boolean;
}

const CROP_BORDERS: SubjectBlendBorders = {
  left: false,
  top: false,
  right: false,
  bottom: false,
};

/** Keep this an edge treatment even if a caller requests a larger radius. */
const MAX_RADIUS = 8;

/**
 * Feather a subject inward without introducing pixels outside its silhouette.
 * The Gaussian is capped by the original alpha. A small inward bias relative
 * to nearby stronger alpha also reduces background fringe in soft contours,
 * which a blur alone barely changes. Opaque interiors, uniform transparency,
 * and local maxima of fine detail receive no additional bias.
 *
 * A true border touches the source photo and repeats its boundary alpha. Other
 * borders surround a trimmed cutout and sample transparent pixels beyond it.
 * Radius is the kernel's support in source pixels; fractional values are valid.
 * Inputs are never changed, including when the radius is zero.
 */
export function featherSubjectAlpha(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  borders: SubjectBlendBorders = CROP_BORDERS,
): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width < 0 || height < 0 || alpha.length !== width * height) {
    throw new RangeError('Subject alpha dimensions must match its pixel count.');
  }
  if (!Number.isFinite(radius) || radius < 0) {
    throw new RangeError('Subject feather radius must be finite and non-negative.');
  }
  if (radius === 0 || alpha.length === 0) return new Uint8ClampedArray(alpha);

  const boundedRadius = Math.min(radius, MAX_RADIUS);
  const support = Math.ceil(boundedRadius);
  const sigma = Math.max(Number.MIN_VALUE, boundedRadius / 2);
  const kernel = new Float64Array(support * 2 + 1);
  let total = 0;
  for (let offset = -support; offset <= support; offset++) {
    const weight = Math.exp(-0.5 * (offset / sigma) ** 2);
    kernel[offset + support] = weight;
    total += weight;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;

  // Retain fractional alpha between passes so low-opacity details do not
  // disappear from rounding each axis separately.
  const horizontal = new Float32Array(alpha.length);
  const horizontalMax = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let strongest = 0;
      for (let offset = -support; offset <= support; offset++) {
        const weight = kernel[offset + support];
        if (weight === 0) continue;
        let sx = x + offset;
        if (sx < 0) {
          if (!borders.left) continue;
          sx = 0;
        } else if (sx >= width) {
          if (!borders.right) continue;
          sx = width - 1;
        }
        const sample = alpha[row + sx];
        sum += sample * weight;
        if (sample > strongest) strongest = sample;
      }
      horizontal[row + x] = sum;
      horizontalMax[row + x] = strongest;
    }
  }

  const output = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const original = alpha[row + x];
      if (original === 0) continue;
      let sum = 0;
      let strongest = original;
      for (let offset = -support; offset <= support; offset++) {
        const weight = kernel[offset + support];
        if (weight === 0) continue;
        let sy = y + offset;
        if (sy < 0) {
          if (!borders.top) continue;
          sy = 0;
        } else if (sy >= height) {
          if (!borders.bottom) continue;
          sy = height - 1;
        }
        const index = sy * width + x;
        sum += horizontal[index] * weight;
        if (horizontalMax[index] > strongest) strongest = horizontalMax[index];
      }
      const bias = strongest > original ? Math.sqrt(original / strongest) : 1;
      output[row + x] = Math.round(Math.min(original, sum) * bias);
    }
  }
  return output;
}
