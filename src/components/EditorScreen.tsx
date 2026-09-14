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
import { layerImageData, hitTestLayers, docMaskToLayerSpace } from '../layers/layer-utils';
import { exportDocument } from '../layers/compositor';
import { downloadBlob, exportFilename } from '../utils/export-utils';
import { encodeProject, projectFilename } from '../project/project-file';
import { pathToPolyline } from '../rendering/sample-path';
import { LayerCanvas } from '../editor/LayerCanvas';
import { SelectionOverlay } from '../editor/SelectionOverlay';
import { StretchPathEditor } from '../editor/StretchPathEditor';
import { StretchRectHandles } from '../editor/StretchRectHandles';
import { StretchArcHandles } from '../editor/StretchArcHandles';
import { MarchingAnts } from '../editor/MarchingAnts';
import { BrushTool } from '../editor/BrushTool';
import { Toolbar } from './Toolbar';
import { LayersPanel } from './LayersPanel';
import { SelectionSection } from './SelectionSection';
import { StretchPanel } from './StretchPanel';
import logo from '../assets/logo.png';
import '../editor/StretchOverlays.css';
import './EditorScreen.css';

type EditorSource =
  | { kind: 'image'; image: SourceImage }
  | { kind: 'project'; document: LayerDocument; selectedLayerId: string | null };

interface EditorScreenProps { source: EditorSource }

const TOOL_HINTS: Record<EditorTool, string> = {
  move: 'Click a layer to select it · drag to reposition · arrow keys to nudge',
  'select-auto': 'Auto selects the main subject · use Tap or Brush for a different region',
  'select-tap': 'Click the object to select it · Alt-click to exclude a region',
  'select-brush': 'Paint roughly over the object, then release to refine',
  stretch: 'Draw a sample path · the main subject will be lifted above the stretch automatically',
};

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

export function EditorScreen({ source }: EditorScreenProps) {
  const layers = useLayers();
  const seg = useSegmentation();
  const { doc, selectedLayer, selectedId } = layers;

  const [tool, setTool] = useState<EditorTool>('move');
  /** Which layer the current segmentation result belongs to. */
  const [selectionLayerId, setSelectionLayerId] = useState<string | null>(null);
  /** The sample path being shaped, before it becomes a band. */
  const [draft, setDraft] = useState<StretchDraft | null>(null);
  /** Live rectangle while the band is being pulled off a locked path. */
  const [extruding, setExtruding] = useState<number | null>(null);
  const [bandMode, setBandMode] = useState<BandMode>('straight');
  /** Live sweep while an arc band is being pulled off a locked path. */
  const [arcPull, setArcPull] = useState<ArcBand | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState({ width: 0, height: 0 });
  const [isExporting, setIsExporting] = useState(false);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [pendingStretch, setPendingStretch] = useState<PendingProtectedStretch | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; docX: number; docY: number; moved: boolean } | null>(null);
  const stretchDragRef = useRef<'draw' | 'extrude' | 'sweep' | null>(null);
  /** Where the sweep was grabbed, relative to the path's midpoint. */
  const sweepGrabRef = useRef<Point>({ x: 0, y: 0 });

  const { segment, encodeImage, addPoint, refineBrush, clear: clearSeg } = seg;
  const {
    initFromImage, initFromDocument, select, beginHistory, translateTransient, nudge,
    extractToLayer, addStretchLayer, addProtectedStretch, updateStretch,
  } = layers;

  // --- Document bootstrap -------------------------------------------------

  useEffect(() => {
    if (source.kind === 'image') initFromImage(source.image);
    else initFromDocument(source.document, source.selectedLayerId);
  }, [source, initFromImage, initFromDocument]);

  // --- Fit the document into the viewport ---------------------------------

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !doc.width || !doc.height) return;

    const fit = () => {
      const inset = window.matchMedia('(max-width: 760px)').matches ? 20 : 56;
      const available = { w: el.clientWidth - inset, h: el.clientHeight - inset };
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

    if (tool === 'move' || tool === 'stretch') {
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
    if (selection || (tool === 'stretch' && selectedLayer?.stretch)) setIsPanelOpen(true);
  }, [selection, tool, selectedLayer?.stretch]);

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

    if (tool === 'move') {
      const hit = hitTestLayers(doc.layers, point.x, point.y);
      if (!hit) return;
      select(hit.id);
      dragRef.current = { id: hit.id, docX: point.x, docY: point.y, moved: false };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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

    const drag = dragRef.current;
    if (!drag) return;
    // Snapshot once, on the first actual movement, so one drag is one undo.
    if (!drag.moved) {
      drag.moved = true;
      beginHistory();
    }
    translateTransient(drag.id, point.x - drag.docX, point.y - drag.docY);
    drag.docX = point.x;
    drag.docY = point.y;
  }, [draft, toDocPoint, beginHistory, translateTransient]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
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
    setBandMode(selectedLayer.stretch.arc ? 'arc' : 'straight');
    setDraft({ points: selectedLayer.stretch.points, locked: false, layerId: selectedLayer.id });
  }, [selectedLayer, beginHistory]);

  const handleBrushComplete = useCallback((mask: Uint8Array, w: number, h: number) => {
    if (!selectedLayer) return;
    // The brush paints in document space; SAM was encoded on one layer.
    const layerMask = docMaskToLayerSpace(mask, w, h, selectedLayer);
    setSelectionLayerId(selectedLayer.id);
    refineBrush(layerMask, selectedLayer.width, selectedLayer.height);
  }, [selectedLayer, refineBrush]);

  // --- Stretch editing -----------------------------------------------------

  const stretchSpec = selectedLayer?.stretch ?? null;
  /** A selected band shows its own mode; a path in progress shows the next pull's. */
  const shownBandMode: BandMode = !draft && stretchSpec ? (stretchSpec.arc ? 'arc' : 'straight') : bandMode;

  const handleBandModeChange = useCallback((next: BandMode) => {
    setBandMode(next);
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

  // --- Actions -------------------------------------------------------------

  const handleExtract = useCallback((mode: ExtractMode) => {
    if (!selection || !selectedLayer) return;
    const created = extractToLayer(
      selectedLayer.id, selection.mask, selection.width, selection.height, mode,
    );
    if (created) {
      deselect();
      setTool('move');
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
      setNotice(`Project saved · ${doc.layers.length} layer${doc.layers.length === 1 ? '' : 's'}`);
    } catch (err) {
      setNotice(err instanceof Error ? `Project save failed: ${err.message}` : 'Project save failed.');
    } finally {
      setIsSavingProject(false);
    }
  }, [doc, selectedId, isSavingProject]);

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
        setTool('move');
        return;
      }
      if (!selectedId) return;

      const step = e.shiftKey ? 10 : 1;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
        ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      if (delta[e.key]) {
        e.preventDefault();
        nudge(selectedId, delta[e.key][0], delta[e.key][1]);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, nudge, deselect, layers, isPanelOpen]);

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

  // The transform box belongs to the stretch tool; it would fight the move tool.
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

  const stretchSource = stretchSpec
    ? doc.layers.find((l) => l.id === stretchSpec.sourceLayerId) ?? null
    : null;

  const stretchHint = draft
    ? draft.locked
      ? bandMode === 'arc'
        ? 'Drag away from the path and curve round to sweep the band · come back to the start to close a ring'
        : 'Drag away from the path to pull the band out'
      : 'Drag the hollow midpoints to bend the path · double-click a point to remove it · 🔒 to lock'
    : stretchSpec
      ? stretchSpec.arc
        ? 'Centre sets the radius · square the width · round end the sweep · drag a ◇ on an edge to add a spline point'
        : stretchSpec.warpMode === 'curved'
        ? 'Round handles make a 2D wave · corner handles keep the fold effect'
        : 'Drag a corner to skew the rectangle in 2D · use the curve button for waves'
      : TOOL_HINTS.stretch;

  const busy = seg.isModelLoading || seg.isProcessing;
  const statusText = pendingStretch
    ? seg.isModelLoading
      ? seg.loadStatus || 'Loading subject model…'
      : 'Detecting and lifting the main subject…'
    : seg.isModelLoading
      ? seg.loadStatus || 'Loading model…'
      : seg.isProcessing
        ? 'Working…'
      : tool === 'stretch'
        ? stretchHint
        : TOOL_HINTS[tool];

  const scale = view.width && doc.width ? view.width / doc.width : 1;

  return (
    <div className="editor-screen">
      <header className="editor-header">
        <div className="editor-brand">
          <img className="editor-logo" src={logo} alt="" />
          PixelStretch
        </div>

        <div className="editor-header-actions">
          <button className="header-btn icon-btn" aria-label="Undo" disabled={!layers.canUndo} title="Undo (⌘Z)" onClick={layers.undo}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7l-5 5 5 5M5 12h8a6 6 0 016 6" /></svg>
          </button>
          <button className="header-btn icon-btn" aria-label="Redo" disabled={!layers.canRedo} title="Redo (⇧⌘Z)" onClick={layers.redo}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7l5 5-5 5m4-5h-8a6 6 0 00-6 6" /></svg>
          </button>
          <span className="header-divider" />
          <button className="header-btn action-btn" aria-label="Save project" disabled={isSavingProject} onClick={handleSaveProject}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h12l2 2v16H5V3zm3 0v6h8V3M8 21v-7h8v7" /></svg>
            <span>{isSavingProject ? 'Saving…' : 'Save'}</span>
          </button>
          <button className="header-btn primary action-btn" aria-label="Export PNG" disabled={isExporting} onClick={handleExport}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4l4 4 4-4M5 17v4h14v-4" /></svg>
            <span>{isExporting ? 'Exporting…' : 'Export'}</span>
          </button>
        </div>
      </header>

      <div className="editor-body">
        <Toolbar
          tool={tool}
          onToolChange={(next) => {
            setIsPanelOpen(false);
            setPendingStretch(null);
            setArcPull(null);
            if (next !== tool) clearSeg();
            // An unfinished path doesn't survive leaving the tool.
            if (next !== 'stretch') setDraft(null);
            if (next === tool && selectedLayer) {
              if (next === 'select-auto') segment(layerImageData(selectedLayer));
              else if (next === 'select-tap' || next === 'select-brush') encodeImage(layerImageData(selectedLayer));
            }
            setTool(next);
          }}
          disabled={false}
          layersOpen={isPanelOpen}
          onLayersClick={() => setIsPanelOpen((open) => !open)}
        />

        <main className="editor-stage" ref={containerRef}>
          {view.width > 0 && (
            <div
              ref={wrapperRef}
              className={`editor-canvas-wrapper tool-${tool}`}
              aria-busy={busy}
              data-selection-ready={seg.isEncoded}
              style={{ width: view.width, height: view.height }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <LayerCanvas doc={doc} viewWidth={view.width} viewHeight={view.height} />

              {tool === 'stretch' && selectedLayer && (
                <div
                  className="stretch-band-mode"
                  role="group"
                  aria-label="Band shape"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  {(['straight', 'arc'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={shownBandMode === mode ? 'active' : ''}
                      aria-pressed={shownBandMode === mode}
                      onClick={() => handleBandModeChange(mode)}
                    >
                      {mode === 'arc' ? 'Arc' : 'Straight'}
                    </button>
                  ))}
                </div>
              )}

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
                  spec={stretchSpec}
                  arc={stretchSpec.arc}
                  docWidth={doc.width}
                  viewWidth={view.width}
                  viewHeight={view.height}
                  onChange={handleStretchChange}
                  onBeginDrag={beginHistory}
                  onUnlock={handleEditPath}
                />
              )}

              {showRectHandles && stretchSpec && !stretchSpec.arc && (
                <StretchRectHandles
                  spec={stretchSpec}
                  docWidth={doc.width}
                  viewWidth={view.width}
                  viewHeight={view.height}
                  onChange={handleStretchChange}
                  onBeginDrag={beginHistory}
                  onUnlock={handleEditPath}
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

              <BrushTool
                width={view.width}
                height={view.height}
                imageWidth={doc.width}
                imageHeight={doc.height}
                onBrushComplete={handleBrushComplete}
                key={selectedLayer?.id}
                active={tool === 'select-brush' && seg.isEncoded}
              />

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

          <div
            className={`editor-hint ${notice ? 'warn' : ''} ${seg.loadError && !busy ? 'error' : ''}`}
          >
            {seg.loadError && !busy
              ? `Model error — ${seg.loadError}`
              : notice ?? statusText}
          </div>
        </main>

        <aside className={`right-panel ${isPanelOpen ? 'open' : ''}`} aria-label="Layers and properties">
          <div className="panel-mobile-header">
            <span className="panel-drag-handle" />
            <strong>Layers &amp; properties</strong>
            <button aria-label="Close panel" onClick={() => setIsPanelOpen(false)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          {selection && (
            <SelectionSection onExtract={handleExtract} onDeselect={() => { deselect(); setTool('move'); }} />
          )}

          {selectedLayer && stretchSpec && (
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

          <LayersPanel
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
          />
        </aside>
      </div>
    </div>
  );
}
