import { useState, useCallback, useRef, useEffect } from 'react';
import type { SegmentationResult, PointPrompt } from '../types/segmentation';
import { maskBoundingBox, brushMaskToBox } from './mask-utils';
import type { SegmentationTask, WorkerResponse } from './worker-types';

export function useSegmentation() {
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadStatus, setLoadStatus] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<SegmentationResult | null>(null);
  const [points, setPoints] = useState<PointPrompt[]>([]);
  const [isEncoded, setIsEncoded] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const pointsRef = useRef<PointPrompt[]>([]);
  const encodedRef = useRef(false);
  const sizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => () => {
    requestId.current++;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  const dispatch = useCallback((task: SegmentationTask) => {
    const id = ++requestId.current;
    setLoadError(null);
    setIsModelLoading(false);
    setLoadProgress(0);
    setIsProcessing(task.type !== 'clear');
    try {
      if (!workerRef.current) {
        const worker = new Worker(new URL('./segmentation.worker.ts', import.meta.url), { type: 'module' });
        workerRef.current = worker;
        worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
          if (data.id !== requestId.current) return;
          if (data.type === 'progress') {
            setIsModelLoading(data.progress < 1);
            setLoadProgress(data.progress);
            setLoadStatus(data.status);
            return;
          }
          setIsModelLoading(false);
          setIsProcessing(false);
          if (data.type === 'error') {
            setLoadError(data.message);
          } else if (data.type === 'encoded') {
            encodedRef.current = true;
            setIsEncoded(true);
          } else if (data.type === 'result') {
            const { mask, width, height } = data;
            const bbox = maskBoundingBox(mask, width, height, 0.5);
            setResult(bbox ? { mask, width, height, bbox } : null);
            if (!bbox) setLoadError('No subject found. Try Tap or Brush to choose a region.');
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          setLoadError(event.message || 'Selection could not start. Please retry.');
          setIsProcessing(false);
          setIsModelLoading(false);
          encodedRef.current = false;
          setIsEncoded(false);
          worker.terminate();
          workerRef.current = null;
        };
      }
      const transfer = 'imageData' in task ? [task.imageData.data.buffer] : [];
      workerRef.current.postMessage({ ...task, id }, transfer);
    } catch (error) {
      setIsProcessing(false);
      setIsModelLoading(false);
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const resetSelection = useCallback(() => {
    setResult(null);
    pointsRef.current = [];
    setPoints([]);
    encodedRef.current = false;
    setIsEncoded(false);
  }, []);

  const startImage = useCallback((type: 'segment' | 'encode', image: ImageData) => {
    resetSelection();
    const input = image;
    sizeRef.current = { width: input.width, height: input.height };
    dispatch({ type, imageData: input });
  }, [dispatch, resetSelection]);
  const segment = useCallback((image: ImageData) => startImage('segment', image), [startImage]);
  const encodeImage = useCallback((image: ImageData) => startImage('encode', image), [startImage]);

  const addPoint = useCallback((point: PointPrompt) => {
    if (!encodedRef.current) return;
    // A ref preserves rapid successive taps before React's next render.
    pointsRef.current = [...pointsRef.current, point];
    setPoints(pointsRef.current);
    dispatch({ type: 'decode', points: pointsRef.current });
  }, [dispatch]);

  const clearPoints = useCallback(() => {
    requestId.current++;
    pointsRef.current = [];
    setPoints([]);
    setResult(null);
    setIsProcessing(false);
    setLoadError(null);
  }, []);

  const refineBrush = useCallback((mask: Uint8Array, width: number, height: number) => {
    if (!encodedRef.current) return;
    const box = brushMaskToBox(mask, width, height);
    if (!box) { clearPoints(); return; }
    const sx = sizeRef.current.width / width;
    const sy = sizeRef.current.height / height;
    dispatch({ type: 'decode', points: [], box: [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy] });
  }, [dispatch, clearPoints]);

  const clear = useCallback(() => {
    resetSelection();
    if (workerRef.current) dispatch({ type: 'clear' });
    else requestId.current++;
    setLoadError(null);
    setIsProcessing(false);
    setIsModelLoading(false);
  }, [dispatch, resetSelection]);

  return { isModelLoading, loadProgress, loadStatus, loadError, isProcessing, result,
    segment, encodeImage, addPoint, clearPoints, refineBrush, clear, points, isEncoded };
}
