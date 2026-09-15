import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { EditorTool, ExtractMode } from '../types/editor';
import type { StretchSpec, Point } from '../types/stretch';
import type { SourceImage } from '../types/image';
import type { LayerDocument } from '../types/layer';
import { DEFAULT_STRETCH, chordLength, bandBasis, initialRect, bandCorners } from '../types/stretch';
import type { ArcBand } from '../types/arc-band';
import { arcFromPull, arcOutline, arcPoint, arcToStraight, straightToArc } from '../types/arc-band';
import { useLayers } from '../layers/use-layers';
import { useSegmentation } from '../segmentation/use-segmentation';
import { layerImageData, hitTestLayers } from '../layers/layer-utils';
import { exportDocument } from '../layers/compositor';
import { downloadBlob, exportFilename } from '../utils/export-utils';
import { encodeProject, projectFilename } from '../project/project-file';
import { rememberProject, RecentStorageFullError } from '../project/recents';
import { pathToPolyline } from '../rendering/sample-path';
import { LayerCanvas } from '../editor/LayerCanvas';
import { SelectionOverlay } from '../editor/SelectionOverlay';
import { StretchPathEditor } from '../editor/StretchPathEditor';
import { StretchRectHandles } from '../editor/StretchRectHandles';
import { StretchArcHandles } from '../editor/StretchArcHandles';
import { MarchingAnts } from '../editor/MarchingAnts';
import { EditorMenu } from './EditorMenu';
import { useWorkspacePan } from '../editor/use-workspace-pan';
import { LayersPanel } from './LayersPanel';
import { SelectionSection } from './SelectionSection';
import { StretchTools, type StretchControl } from './StretchTools';
import { StretchPanel } from './StretchPanel';
import { Icon } from './Icon';
import '../editor/StretchOverlays.css';
import './EditorScreen.css';

export type EditorSource =
  | { kind: 'image'; image: SourceImage }
  | { kind: 'project'; document: LayerDocument; selectedLayerId: string | null };

interface EditorScreenProps {
  source: EditorSource;
  /** Name shown in Recent projects once this document is saved. */
  name: string;
  /** Stored project this document was opened from, so saving updates it in place. */
  recentProjectId: string | null;
  onExit: () => void;
}

/** Shorter than this and the drag was probably a stray click, not a line. */
const MIN_SAMPLE_LINE = 6;

/** How a band leaves its locked path: pulled out flat, or swept round a pivot. */
type BandMode = 'straight' | 'arc';

/**
 * The sample path being shaped, before (and while) it drives a band.
 * `layerId` is set when an existing band's path is reopened for editing.
 */
interface StretchDraft {
  points: Point[];
  locked: boolean;
  layerId: string | null;
}

interface PendingProtectedStretch {
  spec: StretchSpec;
  name: string;
}

export function EditorScreen({ source, name, recentProjectId, onExit }: EditorScreenProps) {
  const layers = useLayers();
  const seg = useSegmentation();
  const { doc, selectedLayer, selectedId } = layers;

  const [tool, setTool] = useState<EditorTool>('stretch');
  /** Which layer the current segmentation result belongs to. */
  const [selectionLayerId, setSelectionLayerId] = useState<string | null>(null);
  /** The sample path being shaped, before it becomes a band. */
  const [draft, setDraft] = useState<StretchDraft | null>(null);
  /** Live rectangle while the band is being pulled off a locked path. */
  const [extruding, setExtruding] = useState<number | null>(null);
  const [bandMode, setBandMode] = useState<BandMode>('straight');
  const [stretchControl, setStretchControl] = useState<StretchControl>('transform');
  /** Live sweep while an arc band is being pulled off a locked path. */
  const [arcPull, setArcPull] = useState<ArcBand | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState({ width: 0, height: 0 });
  const [isExporting, setIsExporting] = useState(false);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [panelContent, setPanelContent] = useState<'layers' | 'properties'>('layers');
  const [pendingStretch, setPendingStretch] = useState<PendingProtectedStretch | null>(null);
  /** The document as of the last save, to tell whether leaving would lose edits. */
  const [savedDoc, setSavedDoc] = useState<LayerDocument | null>(null);
  const recentProjectIdRef = useRef(recentProjectId);

  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const stretchDragRef = useRef<'draw' | 'extrude' | 'sweep' | null>(null);
  /** Where the sweep was grabbed, relative to the path's midpoint. */
  const sweepGrabRef = useRef<Point>({ x: 0, y: 0 });

  const { segment, encodeImage, addPoint, clear: clearSeg } = seg;
  const {
    initFromImage, initFromDocument, select, beginHistory,
    extractToLayer, addStretchLayer, addProtectedStretch, updateStretch,
  } = layers;

  // --- Document bootstrap -------------------------------------------------

  useEffect(() => {
    if (source.kind === 'image') initFromImage(source.image);
    else initFromDocument(source.document, source.selectedLayerId);
  }, [source, initFromImage, initFromDocument]);

  useEffect(() => { setStretchControl('transform'); }, [selectedId, tool]);

  // --- Fit the document into the viewport ---------------------------------

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !doc.width || !doc.height) return;

    const fit = () => {
      const mobile = window.matchMedia('(max-width: 760px)').matches;
      const available = { w: el.clientWidth - (mobile ? 16 : 80), h: el.clientHeight - (mobile ? 32 : 64) };
      if (available.w <= 0 || available.h <= 0) return;
      const scale = Math.min(available.w / doc.width, available.h / doc.height);
      setView({
        width: Math.round(doc.width * scale),
        height: Math.round(doc.height * scale),
      });
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc.width, doc.height]);

  // --- Prime the model for the active tool + layer -------------------------

  const primedRef = useRef('');
  const primedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!selectedLayer) return;
    const key = `${tool}:${selectedLayer.id}`;
    if (primedRef.current === key && primedCanvasRef.current === selectedLayer.canvas) return;
    primedRef.current = key;
    primedCanvasRef.current = selectedLayer.canvas;

    if (tool === 'stretch') {
      clearSeg();
      return;
    }

    const data = layerImageData(selectedLayer);
    setSelectionLayerId(selectedLayer.id);
    if (tool === 'select-auto') {
      segment(data);
    } else {
      encodeImage(data);
    }
  }, [tool, selectedLayer, segment, encodeImage, clearSeg]);

  // A selection only counts while its own layer is the active one.
  const selection = useMemo(() => {
    if (!seg.result || !selectedLayer || selectionLayerId !== selectedLayer.id) return null;
    return seg.result;
  }, [seg.result, selectedLayer, selectionLayerId]);

  useEffect(() => {
    // Only explicit selection tools reveal extraction actions. A stretch's
    // automatic subject mask and geometry updates must never open the sheet.
    if (selection && tool !== 'stretch') setIsPanelOpen(true);
  }, [selection, tool]);

  const deselect = useCallback(() => {
    clearSeg();
    setSelectionLayerId(null);
    primedRef.current = '';
  }, [clearSeg]);

  // Complete a stretch only after the automatic subject mask is ready. Both
  // the lifted subject and the band are committed together as one undo step.
  useEffect(() => {
    if (!pendingStretch) return;

    if (seg.result && selectionLayerId === pendingStretch.spec.sourceLayerId) {
      const created = addProtectedStretch(
        pendingStretch.spec,
        seg.result.mask,
        seg.result.width,
        seg.result.height,
        pendingStretch.name,
      );
      setPendingStretch(null);
      clearSeg();
      setSelectionLayerId(null);
      primedRef.current = '';
      setNotice(created
        ? 'Subject lifted to a new layer · stretch placed underneath'
        : 'The detected subject could not be separated.');
      return;
    }

    if (seg.loadError && !seg.isModelLoading && !seg.isProcessing) {
      const created = addStretchLayer(pendingStretch.spec, pendingStretch.name);
      setPendingStretch(null);
      clearSeg();
      setSelectionLayerId(null);
      setNotice(created
        ? 'Stretch created, but automatic subject protection was unavailable.'
        : 'The stretch could not be created.');
    }
  }, [pendingStretch, seg.result, seg.loadError, seg.isModelLoading, seg.isProcessing,
    selectionLayerId, addProtectedStretch, addStretchLayer, clearSeg]);

  // --- Canvas interaction --------------------------------------------------

  const toDocPoint = useCallback((clientX: number, clientY: number): Point | null => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect?.width) return null;
    const scale = doc.width / rect.width;
    return { x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale };
  }, [doc.width]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (pendingStretch) return;
    const point = toDocPoint(e.clientX, e.clientY);
    if (!point) return;

    if (tool === 'stretch') {
      if (!selectedLayer) return;
      setNotice(null);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      if (!draft) {
        const hit = hitTestLayers(doc.layers, point.x, point.y);
        if (hit?.stretch) {
          select(hit.id);
          return;
        }
        // Nothing yet: drag out the initial straight two-point path.
        stretchDragRef.current = 'draw';
        setDraft({ points: [point, { ...point }], locked: false, layerId: null });
      } else if (draft.locked && !draft.layerId) {
        // Path is committed: this drag pulls the band off it.
        if (bandMode === 'arc') {
          const a = draft.points[0];
          const b = draft.points[draft.points.length - 1];
          // Measured from wherever the drag starts, so grabbing the grip
          // beside the path doesn't jump the band round.
          sweepGrabRef.current = { x: point.x - (a.x + b.x) / 2, y: point.y - (a.y + b.y) / 2 };
          stretchDragRef.current = 'sweep';
          setArcPull(null);
        } else {
          stretchDragRef.current = 'extrude';
          setExtruding(0);
        }
      }
      // While a path is open for shaping, bare-canvas drags do nothing —
      // its own handles own the interaction.
      return;
    }

    if (tool === 'select-tap' && selectedLayer && seg.isEncoded) {
      const nx = (point.x - selectedLayer.x) / selectedLayer.width;
      const ny = (point.y - selectedLayer.y) / selectedLayer.height;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
      setSelectionLayerId(selectedLayer.id);
      addPoint({ x: nx, y: ny, label: e.altKey ? 0 : 1 });
    }
  }, [tool, draft, bandMode, pendingStretch, doc.layers, selectedLayer, seg.isEncoded, toDocPoint, select, addPoint]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const point = toDocPoint(e.clientX, e.clientY);
    if (!point) return;

    if (stretchDragRef.current === 'draw' && draft) {
      setDraft({ ...draft, points: [draft.points[0], point] });
      return;
    }

    if (stretchDragRef.current === 'sweep' && draft) {
      const a = draft.points[0];
      const b = draft.points[draft.points.length - 1];
      const pointer = { x: point.x - sweepGrabRef.current.x, y: point.y - sweepGrabRef.current.y };
      setArcPull((previous) => arcFromPull(a, b, chordLength(draft.points), pointer, previous));
      return;
    }

    if (stretchDragRef.current === 'extrude' && draft) {
      // Distance from the path, measured along its perpendicular.
      const { out } = bandBasis(draft.points);
      const from = draft.points[0];
      setExtruding((point.x - from.x) * out.x + (point.y - from.y) * out.y);
      return;
    }
  }, [draft, toDocPoint]);

  const handlePointerUp = useCallback(() => {
    const gesture = stretchDragRef.current;
    stretchDragRef.current = null;
    if (!gesture || !draft) return;

    if (gesture === 'draw') {
      // Too short to be a deliberate line — throw the draft away.
      if (chordLength(draft.points) < MIN_SAMPLE_LINE) setDraft(null);
      return;
    }

    // 'extrude' or 'sweep': turn the locked path into an actual band layer.
    const length = Math.round(extruding ?? 0);
    const pull = arcPull;
    setExtruding(null);
    setArcPull(null);
    if (!selectedLayer) return;
    if (gesture === 'sweep' ? !pull || Math.abs(pull.sweep) * pull.radius < 1 : Math.abs(length) < 1) return;

    const straight: StretchSpec = {
      ...DEFAULT_STRETCH,
      ...initialRect(draft.points),
      points: draft.points,
      sourceLayerId: selectedLayer.id,
      length,
    };
    // An arc band still carries the straight rectangle it would uncurl into.
    const spec: StretchSpec = gesture === 'sweep' && pull
      ? { ...straight, ...arcToStraight(straight, pull), arc: pull }
      : straight;

    const name = `${selectedLayer.name} stretch`;
    const existingSubject = doc.layers.some((layer) => layer.protectionSourceId === selectedLayer.id);
    setDraft(null);
    if (existingSubject) {
      const created = addProtectedStretch(spec, null, 0, 0, name);
      setNotice(created
        ? 'Stretch placed below the existing subject layer'
        : 'The stretch could not be created.');
    } else {
      setPendingStretch({ spec, name });
      setSelectionLayerId(selectedLayer.id);
      setNotice('Detecting the main subject…');
      segment(layerImageData(selectedLayer));
    }
  }, [draft, extruding, arcPull, selectedLayer, doc.layers, addProtectedStretch, segment]);

  /** Shaping the path re-renders an existing band live. */
  const handlePathChange = useCallback((points: Point[]) => {
    setDraft((current) => (current ? { ...current, points } : current));
    if (draft?.layerId) updateStretch(draft.layerId, { points }, true);
  }, [draft?.layerId, updateStretch]);

  const handleLockPath = useCallback(() => {
    setDraft((current) => {
      if (!current) return current;
      // Reopened bands already have their rectangle; just hand it back.
      if (current.layerId) return null;
      return { ...current, locked: true };
    });
  }, []);

  const handleEditPath = useCallback(() => {
    if (!selectedLayer?.stretch) return;
    beginHistory();
    setTool('stretch');
    setIsPanelOpen(false);
    setBandMode(selectedLayer.stretch.arc ? 'arc' : 'straight');
    setDraft({ points: selectedLayer.stretch.points, locked: false, layerId: selectedLayer.id });
  }, [selectedLayer, beginHistory]);

  // --- Stretch editing -----------------------------------------------------

  const stretchSpec = selectedLayer?.stretch ?? null;
  /** A selected band shows its own mode; a path in progress shows the next pull's. */
  const shownBandMode: BandMode = !draft && stretchSpec ? (stretchSpec.arc ? 'arc' : 'straight') : bandMode;

  const handleBandModeChange = useCallback((next: BandMode) => {
    setBandMode(next);
    setStretchControl('transform');
    if (draft || !stretchSpec || !selectedId) return;
    // Switching a finished band curls or uncurls it in place.
    if (next === 'arc' && !stretchSpec.arc) {
      updateStretch(selectedId, { arc: straightToArc(stretchSpec) });
    } else if (next === 'straight' && stretchSpec.arc) {
      updateStretch(selectedId, arcToStraight(stretchSpec, stretchSpec.arc));
    }
  }, [draft, stretchSpec, selectedId, updateStretch]);

  const handleStretchChange = useCallback(
    (patch: Partial<StretchSpec>, transient: boolean) => {
      if (selectedId) updateStretch(selectedId, patch, transient);
    },
    [selectedId, updateStretch],
  );

  const openStretchProperties = useCallback(() => {
    setPanelContent('properties');
    setIsPanelOpen(true);
    panelRef.current?.scrollTo({ top: 0 });
  }, []);

  // --- Actions -------------------------------------------------------------

  const handleExtract = useCallback((mode: ExtractMode) => {
    if (!selection || !selectedLayer) return;
    const created = extractToLayer(
      selectedLayer.id, selection.mask, selection.width, selection.height, mode,
    );
    if (created) {
      deselect();
      setTool('stretch');
    }
  }, [selection, selectedLayer, extractToLayer, deselect]);

  const handleExport = useCallback(async () => {
    if (!doc.width) return;
    setIsExporting(true);
    try {
      const blob = await exportDocument(doc, 'image/png');
      downloadBlob(blob, exportFilename('png'));
    } catch (err) {
      setNotice(err instanceof Error ? `Export failed: ${err.message}` : 'Export failed. Please try again.');
    } finally {
      setIsExporting(false);
    }
  }, [doc]);

  const handleSaveProject = useCallback(async () => {
    if (!doc.width || isSavingProject) return;
    setIsSavingProject(true);
    setNotice(null);
    try {
      const blob = await encodeProject(doc, selectedId);
      downloadBlob(blob, projectFilename());
      setSavedDoc(doc);
      const layerSummary = `${doc.layers.length} layer${doc.layers.length === 1 ? '' : 's'}`;
      try {
        recentProjectIdRef.current = await rememberProject(recentProjectIdRef.current, name, doc, blob);
        setNotice(`Project saved · ${layerSummary}`);
      } catch (err) {
        console.warn('Could not keep project in recents:', err);
        setNotice(err instanceof RecentStorageFullError
          ? `Project file saved · ${layerSummary} · too large to keep in Recent projects`
          : `Project file saved · ${layerSummary} · could not add it to Recent projects`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? `Project save failed: ${err.message}` : 'Project save failed.');
    } finally {
      setIsSavingProject(false);
    }
  }, [doc, selectedId, isSavingProject, name]);

  const handleExit = useCallback(() => {
    const hasUnsavedEdits = layers.canUndo && doc !== savedDoc;
    if (hasUnsavedEdits && !window.confirm('Leave the editor? Edits made since the last save will be lost.')) return;
    onExit();
  }, [layers.canUndo, doc, savedDoc, onExit]);

  // --- Keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) layers.redo();
        else layers.undo();
        return;
      }
      if (e.key === 'Escape') {
        if (isPanelOpen) {
          setIsPanelOpen(false);
          return;
        }
        deselect();
        setPendingStretch(null);
        setDraft(null);
        setExtruding(null);
        setArcPull(null);
        setNotice(null);
        setTool('stretch');
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deselect, layers, isPanelOpen]);

  // --- Derived render values ----------------------------------------------

  /** Selection bbox, re-based from layer space into document space. */
  const antsBbox = useMemo(() => {
    if (!selection?.bbox || !selectedLayer || !doc.width) return null;
    const b = selection.bbox;
    return {
      x: (selectedLayer.x + b.x * selectedLayer.width) / doc.width,
      y: (selectedLayer.y + b.y * selectedLayer.height) / doc.height,
      w: (b.w * selectedLayer.width) / doc.width,
      h: (b.h * selectedLayer.height) / doc.height,
    };
  }, [selection, selectedLayer, doc.width, doc.height]);

  // Show band controls while its sample path is locked.
  const showRectHandles = stretchSpec && tool === 'stretch' && !draft;

  const draftCurve = useMemo(
    () => (draft ? pathToPolyline(draft.points) : []),
    [draft],
  );

  /**
   * Where the pull grip sits: off the middle of a locked path, riding along
   * with the drag so it stays under the cursor.
   */
  const pullGrip = useMemo(() => {
    if (!draft?.locked || !view.width) return null;
    const { out } = bandBasis(draft.points);
    const a = draft.points[0];
    const b = draft.points[draft.points.length - 1];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (bandMode === 'arc' && arcPull) {
      // Ride the far end of the sweep.
      const end = arcPoint(arcPull, 0, 1);
      return { x: end.x * (view.width / doc.width), y: end.y * (view.width / doc.width) };
    }
    const pulled = extruding ?? 0;
    // Stand off far enough to stay clear of the path itself.
    const standoff = (pulled < 0 ? -34 : 34) / (view.width / doc.width);
    const offset = pulled + standoff;
    return {
      x: (mid.x + out.x * offset) * (view.width / doc.width),
      y: (mid.y + out.y * offset) * (view.width / doc.width),
    };
  }, [draft, extruding, bandMode, arcPull, view.width, doc.width]);

  /** Outline of the band as it's being pulled off a locked path. */
  const previewCorners = useMemo(() => {
    if (!draft?.locked || !extruding) return null;
    return bandCorners({
      ...DEFAULT_STRETCH,
      ...initialRect(draft.points),
      points: draft.points,
      sourceLayerId: '',
      length: extruding,
    });
  }, [draft, extruding]);
  const previewArc = useMemo(() => {
    if (!draft?.locked || !arcPull) return null;
    return arcOutline(arcPull, chordLength(draft.points));
  }, [draft, arcPull]);

  const stretchHasSubject = Boolean(stretchSpec)
    && doc.layers.some((l) => l.protectionSourceId === stretchSpec!.sourceLayerId && !l.stretch);
  /** A band laid over its lifted subject, so its streaks can cover and dissolve it. */
  const stretchOverSubject = Boolean(stretchSpec) && (() => {
    const band = doc.layers.findIndex((layer) => layer.id === selectedId);
    const subject = doc.layers.findIndex((layer) => layer.protectionSourceId === stretchSpec!.sourceLayerId && !layer.stretch);
    return subject >= 0 && band > subject;
  })();
  const stretchSource = stretchSpec
    ? doc.layers.find((l) => l.id === stretchSpec.sourceLayerId) ?? null
    : null;

  const busy = seg.isModelLoading || seg.isProcessing;
  const statusText = seg.isModelLoading
    ? seg.loadStatus || 'Loading subject model…'
    : pendingStretch ? 'Detecting and lifting the main subject…' : 'Working…';

  const touchSnapshot = useRef<{ draft: StretchDraft | null; spec: StretchSpec | null; id: string | null } | null>(null);
  const pan = useWorkspacePan(
    () => { touchSnapshot.current = { draft, spec: stretchSpec, id: selectedId }; },
    () => {
      stretchDragRef.current = null;
      setExtruding(null);
      setArcPull(null);
      const snapshot = touchSnapshot.current;
      if (snapshot) {
        setDraft(snapshot.draft);
        if (snapshot.spec && snapshot.id && snapshot.spec !== stretchSpec) {
          // A first-finger drag may have added optional warp/curve fields.
          // Clear those too when restoring the pre-gesture geometry.
          const cleared = Object.fromEntries(Object.keys(stretchSpec ?? {}).map((key) => [key, undefined]));
          updateStretch(snapshot.id, { ...cleared, ...snapshot.spec }, true);
        }
        if (snapshot.id !== selectedId) select(snapshot.id);
        touchSnapshot.current = null;
      }
    },
  );

  const scale = view.width && doc.width ? view.width / doc.width : 1;

  return (
    <div className="editor-screen">
      <div className="editor-body">
        <main className={`editor-stage ${pan.commandHeld ? 'pan-ready' : ''} ${pan.isPanning ? 'is-panning' : ''}`} ref={containerRef} {...pan.handlers}>
          {view.width > 0 && (
            <div
              ref={wrapperRef}
              className={`editor-canvas-wrapper tool-${tool}`}
              aria-busy={busy}
              data-selection-ready={seg.isEncoded}
              style={{ width: view.width, height: view.height, transform: `translate(${pan.offset.x}px, ${pan.offset.y}px)` }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => { stretchDragRef.current = null; setExtruding(null); setArcPull(null); }}
            >
              <LayerCanvas doc={doc} viewWidth={view.width} viewHeight={view.height} />

              {selection && selectedLayer && (
                <SelectionOverlay
                  mask={selection.mask}
                  maskWidth={selection.width}
                  maskHeight={selection.height}
                  layerWidth={selectedLayer.width}
                  layerHeight={selectedLayer.height}
                  offsetX={selectedLayer.x}
                  offsetY={selectedLayer.y}
                  docWidth={doc.width}
                  docHeight={doc.height}
                  viewWidth={view.width}
                  viewHeight={view.height}
                />
              )}

              {antsBbox && <MarchingAnts bbox={antsBbox} width={view.width} height={view.height} />}

              {showRectHandles && stretchSpec?.arc && (
                <StretchArcHandles
                  key={selectedId}
                  spec={stretchSpec}
                  arc={stretchSpec.arc}
                  docWidth={doc.width}
                  viewWidth={view.width}
                  viewHeight={view.height}
                  onChange={handleStretchChange}
                  onBeginDrag={beginHistory}
                  onOpenProperties={openStretchProperties}
                  control={stretchControl}
                />
              )}

              {showRectHandles && stretchSpec && !stretchSpec.arc && (
                <StretchRectHandles
                  key={selectedId}
                  spec={stretchSpec}
                  docWidth={doc.width}
                  viewWidth={view.width}
                  viewHeight={view.height}
                  onChange={handleStretchChange}
                  onBeginDrag={beginHistory}
                  onOpenProperties={openStretchProperties}
                  control={stretchControl}
                />
              )}

              {draft && !draft.locked && (
                <StretchPathEditor
                  points={draft.points}
                  docWidth={doc.width}
                  viewWidth={view.width}
                  viewHeight={view.height}
                  onChange={handlePathChange}
                  onLock={handleLockPath}
                />
              )}

              {draft?.locked && (
                <svg className="stretch-preview" width={view.width} height={view.height}>
                  {previewArc && (
                    <path
                      className="preview-rect"
                      fillRule="evenodd"
                      d={previewArc.map((loop) => (
                        loop.map((p, i) => `${i ? 'L' : 'M'} ${p.x * scale},${p.y * scale}`).join(' ') + ' Z'
                      )).join(' ')}
                    />
                  )}
                  {previewCorners && (
                    <polygon
                      className="preview-rect"
                      points={previewCorners.map((c) => `${c.x * scale},${c.y * scale}`).join(' ')}
                    />
                  )}
                  <polyline
                    className="preview-line"
                    points={draftCurve.map((p) => `${p.x * scale},${p.y * scale}`).join(' ')}
                    fill="none"
                  />
                  {pullGrip && (
                    <g className="preview-pull" transform={`translate(${pullGrip.x}, ${pullGrip.y})`}>
                      <circle r={13} />
                      <path d="M0,-7 L0,7 M-4,-3.5 L0,-7.5 L4,-3.5 M-4,3.5 L0,7.5 L4,3.5" />
                    </g>
                  )}
                </svg>
              )}



              {busy && (
                <div className="editor-busy">
                  <div className="editor-spinner" />
                  <span>{statusText}</span>
                  {seg.isModelLoading && (
                    <div className="editor-progress">
                      <div className="editor-progress-fill" style={{ width: `${seg.loadProgress * 100}%` }} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {(notice || (seg.loadError && !busy)) && (
            <div role="status" className="editor-notice">
              <span>{notice ?? `Model error — ${seg.loadError}`}</span>
              <button aria-label="Dismiss notification" onClick={() => { setNotice(null); clearSeg(); }}><Icon name="check" size={18} /></button>
            </div>
          )}
        </main>
        <nav className="editor-dock" aria-label="Editor tools">
          <EditorMenu name={savedDoc || source.kind === 'project' ? name : null} canUndo={layers.canUndo} canRedo={layers.canRedo}
            saving={isSavingProject} exporting={isExporting}
            onUndo={layers.undo} onRedo={layers.redo} onSave={handleSaveProject}
            onExport={handleExport} onExit={handleExit} onResetView={pan.reset} />
          {selectedLayer && (
            <StretchTools
              key={`${selectedId}-${Boolean(draft)}`}
              spec={draft ? null : stretchSpec}
              bandMode={shownBandMode}
              control={stretchControl}
              hasSubject={stretchHasSubject}
              canDelete={doc.layers.length > 1}
              onBandModeChange={handleBandModeChange}
              onControlChange={setStretchControl}
              onChange={handleStretchChange}
              onBeginEdit={beginHistory}
              overSubject={stretchOverSubject}
              onOverSubjectChange={(over) => {
                const band = doc.layers.findIndex((layer) => layer.id === selectedLayer.id);
                const subject = doc.layers.findIndex((layer) => (
                  layer.protectionSourceId === stretchSpec?.sourceLayerId && !layer.stretch
                ));
                // Removing the band shifts the subject down when the band was below it,
                // so the subject's own index is the right target both ways.
                if (band >= 0 && subject >= 0 && over !== band > subject) layers.reorder(band, subject);
              }}
              onEditPath={handleEditPath}
              onDuplicate={() => layers.duplicate(selectedLayer.id)}
              onDelete={() => layers.remove(selectedLayer.id)}
            />
          )}
          <button className={`stretch-tool ${isPanelOpen ? 'selected' : ''}`} aria-label="Layers"
            aria-expanded={isPanelOpen} aria-controls="layers-and-properties"
            onClick={() => { setPanelContent('layers'); setIsPanelOpen((open) => panelContent !== 'layers' || !open); }}>
            <Icon name="layers" size={22} /><span>Layers</span>
          </button>
        </nav>

        <aside ref={panelRef} id="layers-and-properties" className={`right-panel ${isPanelOpen ? 'open' : ''}`} aria-label="Layers and properties">
          <div className="panel-mobile-header">
            <span className="panel-drag-handle" />
            <strong>{panelContent === 'layers' ? 'Layers' : 'Stretch properties'}</strong>
            <button aria-label="Close panel" onClick={() => setIsPanelOpen(false)}>
              <Icon name="check" />
            </button>
          </div>
          {selection && (
            <SelectionSection onExtract={handleExtract} onDeselect={() => { deselect(); setTool('stretch'); }} />
          )}

          {panelContent === 'properties' && selectedLayer && stretchSpec && (
            <StretchPanel
              layer={selectedLayer}
              spec={stretchSpec}
              sourceName={stretchSource?.name ?? null}
              maxLength={Math.max(doc.width, doc.height)}
              onChange={handleStretchChange}
              onBeginEdit={beginHistory}
              onEditPath={handleEditPath}
            />
          )}

          {panelContent === 'layers' && <LayersPanel
            doc={doc}
            selectedId={selectedId}
            onSelect={select}
            onUpdate={layers.update}
            onPatchTransient={layers.patchTransient}
            onBeginHistory={beginHistory}
            onRename={layers.rename}
            onRemove={layers.remove}
            onDuplicate={layers.duplicate}
            onReorder={layers.reorder}
          />}
        </aside>
      </div>
    </div>
  );
}
