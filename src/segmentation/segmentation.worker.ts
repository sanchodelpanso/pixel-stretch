import { env } from '@huggingface/transformers';
import { segmentSubject } from './subject-local';
import { encodeSam, decodeSam, clearSamEncoding } from './sam-local';
import type { WorkerRequest, WorkerResponse } from './worker-types';

env.allowLocalModels = false;
// Vite serves this as a module worker; inference and preprocessing stay off the UI thread.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
};
let queue = Promise.resolve();
scope.onmessage = ({ data }) => {
  // SAM embeddings belong to one image. Never overlap encoder/decoder operations.
  queue = queue.then(async () => {
    const send = (type: 'encoded' | 'cleared') => scope.postMessage({ type, id: data.id });
    const progress = (progress: number, status: string) =>
      scope.postMessage({ id: data.id, type: 'progress', progress, status });
    try {
      if (data.type === 'clear') {
        clearSamEncoding();
        send('cleared');
      } else if (data.type === 'encode') {
        await encodeSam(data.imageData, progress);
        send('encoded');
      } else {
        const result = data.type === 'segment'
          ? await segmentSubject(data.imageData, progress)
          : await decodeSam(data.points, data.box);
        scope.postMessage({ id: data.id, type: 'result', ...result }, [result.mask.buffer]);
      }
    } catch (error) {
      scope.postMessage({ id: data.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  });
};
