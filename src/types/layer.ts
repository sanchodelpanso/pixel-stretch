import type { StretchSpec } from './stretch';

/**
 * A layer document is a stack of independently-positioned RGBA bitmaps
 * rendered onto a fixed-size canvas. Layer pixels are stored trimmed to
 * their own bounds, so an extracted object costs only its bounding box.
 */
export interface Layer {
  id: string;
  name: string;
  /** Layer pixels (RGBA, straight alpha), sized `width` × `height`. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Top-left position in document pixels. */
  x: number;
  y: number;
  visible: boolean;
  /** 0–1. */
  opacity: number;
  /** Locked layers can't be moved, edited or selected on canvas. */
  locked: boolean;
  /** Data URL for the panel thumbnail, regenerated when pixels change. */
  thumbnail: string;
  /**
   * Set on an automatically lifted subject. Subsequent stretches from the
   * same source reuse this layer instead of creating duplicate cutouts.
   * Compositing feathers its alpha inward; `canvas` retains the original
   * pixels so project round trips do not repeatedly soften the edge.
   */
  protectionSourceId?: string;
  /**
   * Present on generative stretch layers. The pixels are derived from this,
   * so editing it re-renders the layer rather than replacing it by hand.
   */
  stretch?: StretchSpec;
}

export interface LayerDocument {
  width: number;
  height: number;
  /** Bottom-first: index 0 renders first, the last entry renders on top. */
  layers: Layer[];
}
