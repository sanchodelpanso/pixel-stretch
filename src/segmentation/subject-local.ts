import { AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers';
import { loadWithFallback, makeProgressCallback, type ProgressFn } from './backend';

// The 512 export keeps BiRefNet's intermediate tensors within browser memory limits.
export const SUBJECT_MODEL_ID = 'studioludens/birefnet-lite-512';
type Model = Awaited<ReturnType<typeof AutoModel.from_pretrained>>;
let modelPromise: Promise<Model> | null = null;
let processorPromise: ReturnType<typeof AutoProcessor.from_pretrained> | null = null;

async function load(onProgress?: ProgressFn) {
  const progress_callback = makeProgressCallback(onProgress, 'subject model');
  processorPromise ??= AutoProcessor.from_pretrained(SUBJECT_MODEL_ID).catch((error) => {
    processorPromise = null;
    throw error;
  });
  modelPromise ??= loadWithFallback('subject', (choice) =>
    AutoModel.from_pretrained(SUBJECT_MODEL_ID, { ...choice, progress_callback }),
  ).catch((error) => {
    modelPromise = null;
    throw error;
  });
  const [model, processor] = await Promise.all([modelPromise, processorPromise]);
  return { model, processor };
}

export async function segmentSubject(imageData: ImageData, onProgress?: ProgressFn) {
  let { model, processor } = await load(onProgress);
  onProgress?.(1, 'Finding subject…');
  const image = new RawImage(imageData.data, imageData.width, imageData.height, 4).rgb();
  const { pixel_values } = await processor(image);
  let outputs;
  try {
    outputs = await model({ input_image: pixel_values });
  } catch (error) {
    // A GPU can load a graph successfully but fail when executing a shader.
    console.warn('Subject inference failed; retrying on CPU.', error);
    await model.dispose();
    modelPromise = null;
    onProgress?.(0, 'Switching to CPU…');
    modelPromise = AutoModel.from_pretrained(SUBJECT_MODEL_ID, {
      device: 'wasm', dtype: 'fp32',
      progress_callback: makeProgressCallback(onProgress, 'subject model'),
    }).catch((failure) => { modelPromise = null; throw failure; });
    model = await modelPromise;
    onProgress?.(1, 'Finding subject…');
    outputs = await model({ input_image: pixel_values });
  }
  const tensor = outputs.logits ?? outputs.output_image;
  if (!tensor || tensor.dims.length !== 4 || tensor.dims[1] !== 1) {
    throw new Error('The subject model returned an unexpected mask.');
  }
  const [height, width] = tensor.dims.slice(-2);
  // These are logits, not probabilities. Min/max normalization loses calibration.
  const mask = Float32Array.from(tensor.to('float32').data as Float32Array,
    (value) => 1 / (1 + Math.exp(-value)));
  return { mask, width, height };
}
