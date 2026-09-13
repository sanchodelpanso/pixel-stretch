import type { ProgressInfo } from '@huggingface/transformers';

/** Progress reporter shared by the segmentation models: (0–1, status text). */
export type ProgressFn = (progress: number, status: string) => void;

export interface BackendChoice {
  device: 'webgpu' | 'wasm';
  dtype: 'fp16' | 'fp32';
}

let webgpuProbe: Promise<boolean> | null = null;

/**
 * Whether WebGPU is actually usable — `navigator.gpu` existing isn't enough,
 * the adapter request can still come back null.
 */
export function hasWebGPU(): Promise<boolean> {
  if (!webgpuProbe) {
    webgpuProbe = (async () => {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (!gpu) return false;
      try {
        return Boolean(await gpu.requestAdapter());
      } catch {
        return false;
      }
    })();
  }
  return webgpuProbe;
}

/**
 * Backends to try, best first — WebGPU for speed, WASM as the universal fallback.
 *
 * Weights stay fp32 on both. onnxruntime-web's WASM backend runs graph fusions
 * that don't understand fp16 tensors and fails to even build a session
 * ("Attempting to get index by a name which does not exist" out of
 * SimplifiedLayerNormFusion), so fp16 is not an option there. It would be
 * viable on WebGPU and would halve the download, but the fp16 exports' I/O
 * types haven't been verified in a browser here — fp32 in, fp32 out is
 * unambiguous, and it's what these models already ran as.
 */
export async function candidateBackends(): Promise<BackendChoice[]> {
  if (await hasWebGPU()) {
    return [
      { device: 'webgpu', dtype: 'fp32' },
      { device: 'wasm', dtype: 'fp32' },
    ];
  }
  return [{ device: 'wasm', dtype: 'fp32' }];
}

/**
 * Load a model against the first backend that works, degrading rather than
 * failing outright when a driver or a graph optimisation rejects one.
 */
export async function loadWithFallback<T>(
  label: string,
  load: (choice: BackendChoice) => Promise<T>,
): Promise<T> {
  const choices = await candidateBackends();
  let lastError: unknown;

  for (const choice of choices) {
    try {
      return await load(choice);
    } catch (err) {
      lastError = err;
      console.warn(
        `[${label}] ${choice.device}/${choice.dtype} failed to load, trying next backend`,
        err,
      );
    }
  }
  throw lastError;
}

/** Bridge transformers.js load events onto the (progress, status) reporter. */
export function makeProgressCallback(onProgress: ProgressFn | undefined, label: string) {
  if (!onProgress) return undefined;
  return (info: ProgressInfo) => {
    if (info.status === 'progress_total') {
      onProgress(Math.min(0.99, info.progress / 100), `Loading ${label}…`);
    } else if (info.status === 'initiate') {
      onProgress(0, `Loading ${label}…`);
    }
  };
}
