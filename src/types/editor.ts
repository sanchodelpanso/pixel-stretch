/** Tools available in the editor's left rail. */
export type EditorTool = 'move' | 'select-auto' | 'select-tap' | 'select-brush' | 'stretch';

/** How a selection becomes a new layer. */
export type ExtractMode = 'copy' | 'cut';

/** A selection mask living in the coordinate space of one layer. */
export interface LayerSelection {
  /** Id of the layer the mask was computed against. */
  layerId: string;
  /** Soft alpha, 0–1, row-major, sized `width` × `height`. */
  mask: Float32Array;
  width: number;
  height: number;
}
