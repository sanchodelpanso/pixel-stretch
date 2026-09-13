/**
 * HEIC/HEIF support.
 *
 * No browser but Safari decodes HEIC natively, so everywhere else it goes
 * through libheif compiled to WASM (via `heic-to`). That bundle is ~3MB, so
 * it is imported lazily and only once a file has actually been identified as
 * HEIF — the sniff below reads 12 bytes rather than loading a decoder to ask.
 */

/**
 * ISO base media file format brands that mean HEIF-family imagery.
 * `mif1`/`msf1` are the generic HEIF brands; AVIF's `avif`/`avis` are
 * deliberately absent, since browsers decode those natively.
 */
const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx',
  'heim', 'heis', 'hevm', 'hevs',
  'mif1', 'msf1',
]);

const HEIF_MIME = new Set([
  'image/heic', 'image/heif',
  'image/heic-sequence', 'image/heif-sequence',
]);

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/**
 * Whether a file is HEIF-family, by declared MIME type first and then by
 * sniffing the `ftyp` box — many platforms hand over HEICs with an empty
 * `File.type`, so the type alone can't be trusted.
 */
export async function isHeifFile(file: Blob): Promise<boolean> {
  if (HEIF_MIME.has(file.type.toLowerCase())) return true;

  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head.length < 12) return false;
  // [0..4) box size, [4..8) box type, [8..12) major brand.
  if (ascii(head.subarray(4, 8)) !== 'ftyp') return false;
  return HEIF_BRANDS.has(ascii(head.subarray(8, 12)).toLowerCase());
}

/**
 * Decode a HEIF file to a drawable bitmap.
 *
 * Decoding happens in the decoder's own worker, so a 12MP photo doesn't block
 * the UI, and 'bitmap' avoids a lossy re-encode on the way back.
 */
export async function decodeHeif(file: Blob): Promise<ImageBitmap> {
  const { heicTo } = await import('heic-to');
  return heicTo({ blob: file, type: 'bitmap' });
}
