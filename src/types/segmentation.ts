export interface SegmentationResult {
  /** Soft alpha mask, values 0–1. Row-major, top-left origin. */
  mask: Float32Array;
  width: number;
  height: number;
  /** Normalized bounding box of the subject (top-left origin). */
  bbox: BBox | null;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A point prompt for SAM interactive mode. */
export interface PointPrompt {
  /** Normalized x (0–1, fraction of image width). */
  x: number;
  /** Normalized y (0–1, fraction of image height). */
  y: number;
  /** 1 = foreground (include), 0 = background (exclude). */
  label: 0 | 1;
}

