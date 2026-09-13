import type { PointPrompt } from '../types/segmentation';

export type SegmentationTask =
  | { type: 'segment'; imageData: ImageData }
  | { type: 'encode'; imageData: ImageData }
  | { type: 'decode'; points: PointPrompt[]; box?: [number, number, number, number] }
  | { type: 'clear' };
export type WorkerRequest = SegmentationTask & { id: number };
export type WorkerResponse = { id: number } & (
  | { type: 'progress'; progress: number; status: string }
  | { type: 'result'; mask: Float32Array; width: number; height: number }
  | { type: 'encoded' | 'cleared' }
  | { type: 'error'; message: string }
);
