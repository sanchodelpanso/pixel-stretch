/**
 * A decoded bitmap the editor can draw from, whichever way it was decoded.
 * Both members expose numeric `width`/`height` and are valid `drawImage`
 * sources, which is all the layer pipeline needs.
 */
export type SourceImage = HTMLImageElement | ImageBitmap;
