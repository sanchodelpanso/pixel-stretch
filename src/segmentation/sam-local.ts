import { SamModel, SamProcessor, RawImage, Tensor } from '@huggingface/transformers';
import type { PointPrompt } from '../types/segmentation';
import type { ProgressFn } from './backend';
import { loadWithFallback, makeProgressCallback } from './backend';

export type { ProgressFn };

/** SlimSAM is a compact SAM variant for prompted selections in the browser. */
const MODEL_ID = 'Xenova/slimsam-77-uniform';

type SamInstance = { model: SamModel; processor: SamProcessor };

let samPromise: Promise<SamInstance> | null = null;

/** State from the last `encodeSam` call — decoding reuses these embeddings. */
let encoded: {
  embeddings: Record<string, Tensor>;
  originalSizes: [number, number][];
  reshapedSizes: [number, number][];
} | null = null;

/**
 * Load (and cache) the SAM model and its processor.
 */
export async function preloadSam(onProgress?: ProgressFn): Promise<SamInstance> {
  if (!samPromise) {
    const progress_callback = makeProgressCallback(onProgress, 'tap-to-select model');
    samPromise = (async () => {
      const processor = await SamProcessor.from_pretrained(MODEL_ID, { progress_callback }) as SamProcessor;
      const model = await loadWithFallback('sam', (choice) =>
        SamModel.from_pretrained(MODEL_ID, {
          device: choice.device,
          dtype: choice.dtype,
          progress_callback,
        }),
      );
      return { model: model as SamModel, processor };
    })().catch((err) => {
      // Don't cache a failed load — let the next call retry.
      samPromise = null;
      throw err;
    });
  }
  return samPromise!;
}

/**
 * Run the (expensive) SAM image encoder once. Every subsequent point or box
 * prompt only runs the lightweight mask decoder against these embeddings.
 */
export async function encodeSam(imageData: ImageData, onProgress?: ProgressFn): Promise<void> {
  const { model, processor } = await preloadSam(onProgress);
  onProgress?.(1, 'Analyzing image…');

  const image = new RawImage(
    new Uint8ClampedArray(imageData.data),
    imageData.width,
    imageData.height,
    4,
  ).rgb();

  const inputs = await processor(image);
  const embeddings = await model.get_image_embeddings(inputs);

  clearSamEncoding();
  encoded = {
    embeddings: embeddings as unknown as Record<string, Tensor>,
    originalSizes: inputs.original_sizes,
    reshapedSizes: inputs.reshaped_input_sizes,
  };
}

/**
 * Decode a mask from point and/or box prompts against the encoded image.
 *
 * Points are normalized (0–1); the box is in source-image pixels as
 * `[x1, y1, x2, y2]`. Returns a soft 0–1 alpha mask at the image's size.
 */
export async function decodeSam(
  points: PointPrompt[],
  box?: [number, number, number, number],
): Promise<{ mask: Float32Array; width: number; height: number }> {
  if (!encoded) {
    throw new Error('decodeSam called before encodeSam');
  }
  if (points.length === 0 && !box) {
    throw new Error('decodeSam needs at least one point or a box prompt');
  }

  const { model, processor } = await preloadSam();
  const [origH, origW] = encoded.originalSizes[0];
  const [reshapedH, reshapedW] = encoded.reshapedSizes[0];

  const inputs: Record<string, Tensor> = { ...encoded.embeddings };

  // SlimSAM's ONNX decoder accepts points and labels, not an input_boxes tensor.
  // SAM represents box corners with labels 2/3; pad point-only prompts with -1.
  const coords = points.flatMap((p) => [p.x * reshapedW, p.y * reshapedH]);
  const labels: bigint[] = points.map((p) => BigInt(p.label));
  if (box) {
    const sx = reshapedW / origW;
    const sy = reshapedH / origH;
    coords.push(box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy);
    labels.push(2n, 3n);
  } else {
    coords.push(0, 0);
    labels.push(-1n);
  }
  inputs.input_points = new Tensor('float32', coords, [1, 1, labels.length, 2]);
  inputs.input_labels = new Tensor('int64', labels, [1, 1, labels.length]);

  const outputs = await model(inputs);
  const masks = await processor.post_process_masks(
    outputs.pred_masks,
    encoded.originalSizes,
    encoded.reshapedSizes,
    { binarize: false },
  );

  // SAM emits several candidate masks; keep the one it scores highest.
  const scores = outputs.iou_scores.to('float32').data as Float32Array;
  let best = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[best]) best = i;
  }

  // Logits → soft alpha, taking the winning channel of [1, n, H, W].
  const logits = masks[0].to('float32').data as Float32Array;
  const plane = origW * origH;
  const offset = best * plane;
  const mask = new Float32Array(plane);
  for (let i = 0; i < plane; i++) {
    mask[i] = 1 / (1 + Math.exp(-logits[offset + i]));
  }

  return { mask, width: origW, height: origH };
}

/** Drop the cached embeddings (e.g. when a new image is loaded). */
export function clearSamEncoding(): void {
  if (encoded) {
    for (const tensor of Object.values(encoded.embeddings)) tensor.dispose();
  }
  encoded = null;
}
