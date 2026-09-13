import type { SourceImage } from '../types/image';
import { isHeifFile, decodeHeif } from './heic';

/**
 * Decode a user-supplied image file.
 *
 * The browser gets first refusal: if it can decode the file itself, that path
 * costs nothing extra and Safari handles HEIC this way. Only when the native
 * decode fails do we sniff for HEIF and fall back to the WASM decoder, so the
 * heavy bundle is never fetched for an ordinary JPEG or PNG.
 */
export async function loadImageFile(file: File): Promise<SourceImage> {
  try {
    return await decodeNatively(file);
  } catch {
    if (await isHeifFile(file)) {
      try {
        return await decodeHeif(file);
      } catch (err) {
        throw new Error(
          `Couldn't decode “${file.name}” — the HEIC file may be damaged or use an unsupported variant.`,
          { cause: err },
        );
      }
    }
    throw new Error(`“${file.name}” isn't an image this browser can open.`);
  }
}

function decodeNatively(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Native decode failed'));
    };
    img.src = url;
  });
}
