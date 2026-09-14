import { useState, useCallback, useMemo, useRef } from 'react';
import type { Layer, LayerDocument } from '../types/layer';
import type { ExtractMode } from '../types/editor';
import type { StretchSpec } from '../types/stretch';
import type { SourceImage } from '../types/image';
import { pathCrossesSubject } from '../rendering/stretch-band';
import {
  layerFromImage,
  duplicateLayer,
  extractLayer,
  eraseMaskedRegion,
  translateLayer,
  createStretchLayer,
  rerenderStretchLayer,
  protectedSubject,
} from './layer-utils';

const EMPTY_DOC: LayerDocument = { width: 0, height: 0, layers: [] };
const MAX_HISTORY = 30;

export interface UseLayersReturn {
  doc: LayerDocument;
  selectedId: string | null;
  selectedLayer: Layer | null;
  canUndo: boolean;
  canRedo: boolean;
  initFromImage: (image: SourceImage) => void;
  initFromDocument: (document: LayerDocument, selectedLayerId?: string | null) => void;
  select: (id: string | null) => void;
  update: (id: string, patch: Partial<Layer>) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  /** Move a layer within the stack. Both indices are bottom-first. */
  reorder: (from: number, to: number) => void;
  /** Move a layer by a delta, as one undo step. */
  nudge: (id: string, dx: number, dy: number) => void;
  /** Move a layer by a delta without touching the undo stack. */
  translateTransient: (id: string, dx: number, dy: number) => void;
  /**
   * Snapshot the current document for undo without changing it. Call once at
   * the start of a continuous gesture, then use `setPosition` freely.
   */
  beginHistory: () => void;
  /** Patch a layer without touching the undo stack — for continuous gestures. */
  patchTransient: (id: string, patch: Partial<Layer>) => void;
  /**
   * Create a generative stretch layer directly above its source layer.
   * Returns the new layer's id, or null if the band would be degenerate.
   */
  addStretchLayer: (spec: StretchSpec, name?: string) => string | null;
  /** Lift the detected subject and place a new stretch directly beneath it. */
  addProtectedStretch: (
    spec: StretchSpec,
    mask: Float32Array | null,
    maskWidth: number,
    maskHeight: number,
    name?: string,
  ) => string | null;
  /**
   * Re-render a stretch layer against an edited spec. Pass `transient` while a
   * handle or slider is still being dragged so the drag stays one undo step.
   */
  updateStretch: (id: string, patch: Partial<StretchSpec>, transient?: boolean) => void;
  /**
   * Split the masked region of `sourceId` onto a new layer above it.
   * Returns the new layer's id, or null if the mask was empty.
   */
  extractToLayer: (
    sourceId: string,
    mask: Float32Array,
    maskWidth: number,
    maskHeight: number,
    mode: ExtractMode,
    name?: string,
  ) => string | null;
  undo: () => void;
  redo: () => void;
}

export function useLayers(): UseLayersReturn {
  const [doc, setDoc] = useState<LayerDocument>(EMPTY_DOC);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The ref is the source of truth so history bookkeeping stays outside React
  // state updaters, which StrictMode deliberately invokes twice.
  const docRef = useRef<LayerDocument>(EMPTY_DOC);
  const past = useRef<LayerDocument[]>([]);
  const future = useRef<LayerDocument[]>([]);
  // Mirrors the stacks' depth into state; the stacks themselves are refs, and
  // reading a ref during render wouldn't re-render the toolbar when it changes.
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });

  const syncHistory = useCallback(() => {
    setHistory({ canUndo: past.current.length > 0, canRedo: future.current.length > 0 });
  }, []);

  const publish = useCallback((next: LayerDocument) => {
    docRef.current = next;
    setDoc(next);
    syncHistory();
  }, [syncHistory]);

  /**
   * Apply a document change, pushing the previous state onto the undo stack.
   * Snapshots share layer canvases — every mutation builds new Layer objects
   * rather than editing pixels in place — so history is cheap.
   */
  const commit = useCallback((producer: (prev: LayerDocument) => LayerDocument) => {
    const prev = docRef.current;
    const next = producer(prev);
    if (next === prev) return;
    past.current = [...past.current.slice(-(MAX_HISTORY - 1)), prev];
    future.current = [];
    publish(next);
  }, [publish]);

  const initFromImage = useCallback((image: SourceImage) => {
    const background = layerFromImage(image);
    past.current = [];
    future.current = [];
    publish({ width: image.width, height: image.height, layers: [background] });
    setSelectedId(background.id);
  }, [publish]);

  const initFromDocument = useCallback((document: LayerDocument, initialSelection?: string | null) => {
    past.current = [];
    future.current = [];
    publish(document);
    const selected = initialSelection && document.layers.some((layer) => layer.id === initialSelection)
      ? initialSelection
      : document.layers[document.layers.length - 1]?.id ?? null;
    setSelectedId(selected);
  }, [publish]);

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  const update = useCallback((id: string, patch: Partial<Layer>) => {
    commit((prev) => ({
      ...prev,
      layers: prev.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));
  }, [commit]);

  const rename = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (trimmed) update(id, { name: trimmed });
  }, [update]);

  const remove = useCallback((id: string) => {
    const prev = docRef.current;
    // The document always keeps at least one layer.
    if (prev.layers.length <= 1) return;
    const remaining = prev.layers.filter((l) => l.id !== id);
    if (remaining.length === prev.layers.length) return;

    commit(() => ({ ...prev, layers: remaining }));
    setSelectedId((current) =>
      current === id ? remaining[remaining.length - 1].id : current,
    );
  }, [commit]);

  const duplicate = useCallback((id: string) => {
    const prev = docRef.current;
    const index = prev.layers.findIndex((l) => l.id === id);
    if (index < 0) return;

    const copy = duplicateLayer(prev.layers[index]);
    const layers = [...prev.layers];
    layers.splice(index + 1, 0, copy);
    commit(() => ({ ...prev, layers }));
    setSelectedId(copy.id);
  }, [commit]);

  const reorder = useCallback((from: number, to: number) => {
    commit((prev) => {
      if (from === to || from < 0 || from >= prev.layers.length) return prev;
      const layers = [...prev.layers];
      const [moved] = layers.splice(from, 1);
      layers.splice(Math.max(0, Math.min(layers.length, to)), 0, moved);
      return { ...prev, layers };
    });
  }, [commit]);

  const nudge = useCallback((id: string, dx: number, dy: number) => {
    commit((prev) => ({
      ...prev,
      layers: prev.layers.map((l) => (l.id === id ? translateLayer(l, dx, dy) : l)),
    }));
  }, [commit]);

  const translateTransient = useCallback((id: string, dx: number, dy: number) => {
    const prev = docRef.current;
    const next: LayerDocument = {
      ...prev,
      layers: prev.layers.map((l) => (l.id === id ? translateLayer(l, dx, dy) : l)),
    };
    docRef.current = next;
    setDoc(next);
  }, []);

  const beginHistory = useCallback(() => {
    past.current = [...past.current.slice(-(MAX_HISTORY - 1)), docRef.current];
    future.current = [];
    syncHistory();
  }, [syncHistory]);

  const patchTransient = useCallback((id: string, patch: Partial<Layer>) => {
    const prev = docRef.current;
    const next: LayerDocument = {
      ...prev,
      layers: prev.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    };
    docRef.current = next;
    setDoc(next);
  }, []);

  const addStretchLayer = useCallback((spec: StretchSpec, name?: string): string | null => {
    const prev = docRef.current;
    const sourceIndex = prev.layers.findIndex((l) => l.id === spec.sourceLayerId);
    if (sourceIndex < 0) return null;

    const band = createStretchLayer(
      spec, prev.layers[sourceIndex], name ?? 'Stretch', protectedSubject(prev.layers, spec.sourceLayerId),
    );
    if (!band) return null;

    // Directly above its source so the generated pixels remain visible.
    const layers = [...prev.layers];
    layers.splice(sourceIndex + 1, 0, band);

    commit(() => ({ ...prev, layers }));
    setSelectedId(band.id);
    return band.id;
  }, [commit]);

  const addProtectedStretch = useCallback((
    spec: StretchSpec,
    mask: Float32Array | null,
    maskWidth: number,
    maskHeight: number,
    name?: string,
  ): string | null => {
    const prev = docRef.current;
    const sourceIndex = prev.layers.findIndex((layer) => layer.id === spec.sourceLayerId);
    if (sourceIndex < 0) return null;

    const source = prev.layers[sourceIndex];
    // Existing protected subjects stay in place and are reused on later stretches.
    const existingSubject = protectedSubject(prev.layers, source.id);
    let subject = existingSubject;
    if (!subject) {
      if (!mask || maskWidth < 1 || maskHeight < 1) return null;
      subject = extractLayer(source, mask, maskWidth, maskHeight, `${source.name} subject`);
      if (!subject) return null;
      subject.protectionSourceId = source.id;
    }

    // A path drawn through the subject stretches only the subject, leaving the
    // background it crosses on the way clear.
    const shaped: StretchSpec = spec.subjectOnly === undefined
      ? { ...spec, subjectOnly: pathCrossesSubject(spec.points, subject) }
      : spec;
    const band = createStretchLayer(shaped, source, name ?? `${source.name} stretch`, subject);
    if (!band) return null;

    // Bottom-first: source, stretch, protected subject.
    const layers = [...prev.layers];
    layers.splice(sourceIndex + 1, 0, band);
    if (!existingSubject) layers.splice(sourceIndex + 2, 0, subject);

    commit(() => ({ ...prev, layers }));
    setSelectedId(band.id);
    return band.id;
  }, [commit]);

  const updateStretch = useCallback((
    id: string,
    patch: Partial<StretchSpec>,
    transient = false,
  ) => {
    const prev = docRef.current;
    const layer = prev.layers.find((l) => l.id === id);
    if (!layer?.stretch) return;

    const spec: StretchSpec = { ...layer.stretch, ...patch };
    const source = prev.layers.find((l) => l.id === spec.sourceLayerId);
    // Without its source layer the band can't be re-rendered; keep the pixels.
    const updated = source
      ? rerenderStretchLayer(layer, spec, source, protectedSubject(prev.layers, spec.sourceLayerId))
      : { ...layer, stretch: spec };
    const next: LayerDocument = {
      ...prev,
      layers: prev.layers.map((l) => (l.id === id ? updated : l)),
    };

    if (transient) {
      docRef.current = next;
      setDoc(next);
    } else {
      commit(() => next);
    }
  }, [commit]);

  const extractToLayer = useCallback((
    sourceId: string,
    mask: Float32Array,
    maskWidth: number,
    maskHeight: number,
    mode: ExtractMode,
    name?: string,
  ): string | null => {
    const prev = docRef.current;
    const index = prev.layers.findIndex((l) => l.id === sourceId);
    if (index < 0) return null;

    const source = prev.layers[index];
    const extracted = extractLayer(
      source,
      mask,
      maskWidth,
      maskHeight,
      name ?? `${source.name} object`,
    );
    if (!extracted) return null;

    const layers = [...prev.layers];
    if (mode === 'cut') {
      layers[index] = eraseMaskedRegion(source, mask, maskWidth, maskHeight);
    }
    layers.splice(index + 1, 0, extracted);

    commit(() => ({ ...prev, layers }));
    setSelectedId(extracted.id);
    return extracted.id;
  }, [commit]);

  /**
   * Publish a history state without leaving the selection on a layer it
   * doesn't contain — tools that act on the selected layer would go dead.
   * A vanished band or lifted subject hands selection back to its source.
   */
  const publishHistoryState = useCallback((next: LayerDocument) => {
    const current = docRef.current;
    publish(next);
    setSelectedId((id) => {
      if (id && next.layers.some((layer) => layer.id === id)) return id;
      const gone = current.layers.find((layer) => layer.id === id);
      const fallbackId = gone?.stretch?.sourceLayerId ?? gone?.protectionSourceId;
      if (fallbackId && next.layers.some((layer) => layer.id === fallbackId)) return fallbackId;
      return next.layers[next.layers.length - 1]?.id ?? null;
    });
  }, [publish]);

  const undo = useCallback(() => {
    if (!past.current.length) return;
    const previous = past.current[past.current.length - 1];
    past.current = past.current.slice(0, -1);
    future.current = [...future.current, docRef.current];
    publishHistoryState(previous);
  }, [publishHistoryState]);

  const redo = useCallback(() => {
    if (!future.current.length) return;
    const next = future.current[future.current.length - 1];
    future.current = future.current.slice(0, -1);
    past.current = [...past.current, docRef.current];
    publishHistoryState(next);
  }, [publishHistoryState]);

  const selectedLayer = useMemo(
    () => doc.layers.find((l) => l.id === selectedId) ?? null,
    [doc.layers, selectedId],
  );

  return {
    doc,
    selectedId,
    selectedLayer,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    initFromImage,
    initFromDocument,
    select,
    update,
    rename,
    remove,
    duplicate,
    reorder,
    nudge,
    translateTransient,
    beginHistory,
    patchTransient,
    addStretchLayer,
    addProtectedStretch,
    updateStretch,
    extractToLayer,
    undo,
    redo,
  };
}
