import type { Layer, LayerDocument } from '../types/layer';
import type { EdgeWarp, Point, StretchSpec, Warp } from '../types/stretch';
import type { ArcBand } from '../types/arc-band';
import { createCanvas, makeThumbnail } from '../layers/layer-utils';

export const PROJECT_FORMAT = 'com.pixelstretch.project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = 'pixelstretch';
export const PROJECT_MIME = 'application/vnd.pixelstretch.project+json';

interface ProjectBitmap {
  mimeType: 'image/png';
  data: string;
}

export interface ProjectLayer {
  id: string;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  visible: boolean;
  opacity: number;
  locked: boolean;
  protectionSourceId?: string;
  bitmap: ProjectBitmap;
  stretch?: StretchSpec;
}

export interface PixelStretchProject {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  savedAt: string;
  canvas: { width: number; height: number };
  selectedLayerId: string | null;
  /** Bottom-first, matching the editor's render order. */
  layers: ProjectLayer[];
}

export interface LoadedProject {
  document: LayerDocument;
  selectedLayerId: string | null;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('A layer could not be encoded.'))),
      'image/png',
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('A layer could not be read after encoding.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return reject(new Error('A layer could not be encoded.'));
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function base64ToBytes(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error('A project layer contains invalid image data.');
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function encodeLayer(layer: Layer): Promise<ProjectLayer> {
  const blob = await canvasToBlob(layer.canvas);
  return {
    id: layer.id,
    name: layer.name,
    width: layer.width,
    height: layer.height,
    x: layer.x,
    y: layer.y,
    visible: layer.visible,
    opacity: layer.opacity,
    locked: layer.locked,
    ...(layer.protectionSourceId ? { protectionSourceId: layer.protectionSourceId } : {}),
    bitmap: {
      mimeType: 'image/png',
      data: await blobToBase64(blob),
    },
    ...(layer.stretch ? { stretch: layer.stretch } : {}),
  };
}

/** Create a self-contained JSON project. Layer PNGs are embedded as base64. */
export async function encodeProject(
  document: LayerDocument,
  selectedLayerId: string | null,
): Promise<Blob> {
  if (!document.width || !document.height || document.layers.length === 0) {
    throw new Error('There is no project to save.');
  }
  const layers: ProjectLayer[] = [];
  // Encode sequentially to avoid holding several full-resolution PNG encoders in memory.
  for (const layer of document.layers) layers.push(await encodeLayer(layer));
  const project: PixelStretchProject = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    canvas: { width: document.width, height: document.height },
    selectedLayerId,
    layers,
  };
  return new Blob([JSON.stringify(project)], { type: PROJECT_MIME });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Project field “${label}” must be a finite number.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < 1 || number > 32_768) {
    throw new Error(`Project field “${label}” is outside the supported range.`);
  }
  return number;
}

function point(value: unknown, label: string): Point {
  if (!isRecord(value)) throw new Error(`Project field “${label}” is invalid.`);
  return { x: finiteNumber(value.x, `${label}.x`), y: finiteNumber(value.y, `${label}.y`) };
}

function warp(value: unknown, label: string): Warp | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`Project field “${label}” is invalid.`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Project field “${label}[${index}]” is invalid.`);
    return {
      u: finiteNumber(entry.u, `${label}[${index}].u`),
      v: finiteNumber(entry.v, `${label}[${index}].v`),
    };
  }) as Warp;
}

function edges(value: unknown): EdgeWarp | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('Project stretch edges are invalid.');
  }
  return value.map((edge, edgeIndex) => {
    if (!Array.isArray(edge) || edge.length !== 2) {
      throw new Error(`Project stretch edge ${edgeIndex} is invalid.`);
    }
    return edge.map((entry, controlIndex) => {
      if (!isRecord(entry)) throw new Error('Project stretch edge control is invalid.');
      return {
        u: finiteNumber(entry.u, `edges[${edgeIndex}][${controlIndex}].u`),
        v: finiteNumber(entry.v, `edges[${edgeIndex}][${controlIndex}].v`),
      };
    });
  }) as EdgeWarp;
}

function arc(value: unknown): ArcBand | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.outward !== 'boolean') {
    throw new Error('Project stretch arc is invalid.');
  }
  const radius = finiteNumber(value.radius, 'stretch.arc.radius');
  const sweep = finiteNumber(value.sweep, 'stretch.arc.sweep');
  if (radius <= 0 || Math.abs(sweep) > Math.PI * 2 + 1e-9) {
    throw new Error('Project stretch arc is out of range.');
  }
  return {
    origin: point(value.origin, 'stretch.arc.origin'),
    angle: finiteNumber(value.angle, 'stretch.arc.angle'),
    radius,
    sweep,
    outward: value.outward,
  };
}

function stretch(value: unknown): StretchSpec | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.points) || value.points.length < 2) {
    throw new Error('A project stretch object is invalid.');
  }
  if (typeof value.sourceLayerId !== 'string' || value.sourceLayerId.length === 0) {
    throw new Error('A project stretch object has no source layer.');
  }
  if (value.warpMode !== undefined && value.warpMode !== 'straight' && value.warpMode !== 'curved') {
    throw new Error('A project stretch object has an unsupported warp mode.');
  }
  return {
    points: value.points.map((entry, index) => point(entry, `points[${index}]`)),
    sourceLayerId: value.sourceLayerId,
    anchor: point(value.anchor, 'anchor'),
    width: finiteNumber(value.width, 'stretch.width'),
    length: finiteNumber(value.length, 'stretch.length'),
    rotation: finiteNumber(value.rotation, 'stretch.rotation'),
    fade: finiteNumber(value.fade, 'stretch.fade'),
    edgeSoftness: finiteNumber(value.edgeSoftness, 'stretch.edgeSoftness'),
    bend: finiteNumber(value.bend, 'stretch.bend'),
    ...(warp(value.warp, 'stretch.warp') ? { warp: warp(value.warp, 'stretch.warp') } : {}),
    ...(value.warpMode ? { warpMode: value.warpMode } : {}),
    ...(edges(value.edges) ? { edges: edges(value.edges) } : {}),
    ...(value.arc !== undefined ? { arc: arc(value.arc) } : {}),
  };
}

async function decodeBitmap(bitmap: unknown, width: number, height: number): Promise<HTMLCanvasElement> {
  if (!isRecord(bitmap) || bitmap.mimeType !== 'image/png' || typeof bitmap.data !== 'string') {
    throw new Error('A project layer has an unsupported bitmap.');
  }
  const bytes = base64ToBytes(bitmap.data);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: 'image/png' });
  let image: CanvasImageSource;
  try {
    image = await createImageBitmap(blob);
  } catch {
    throw new Error('A project layer image could not be decoded.');
  }
  const canvas = createCanvas(width, height);
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
  if ('close' in image && typeof image.close === 'function') image.close();
  return canvas;
}

/** Decode and validate an untrusted project file before publishing it to the editor. */
export async function decodeProject(file: Blob): Promise<LoadedProject> {
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error('This is not a valid PixelStretch project.');
  }
  if (!isRecord(value) || value.format !== PROJECT_FORMAT) {
    throw new Error('This file is not a PixelStretch project.');
  }
  if (value.version !== PROJECT_VERSION) {
    throw new Error(`Project version ${String(value.version)} is not supported by this app.`);
  }
  if (!isRecord(value.canvas) || !Array.isArray(value.layers) || value.layers.length === 0 || value.layers.length > 500) {
    throw new Error('The project canvas or layer stack is invalid.');
  }
  const documentWidth = positiveInteger(value.canvas.width, 'canvas.width');
  const documentHeight = positiveInteger(value.canvas.height, 'canvas.height');
  const ids = new Set<string>();

  const layers: Layer[] = [];
  // Decode sequentially so large multi-layer projects have a bounded memory spike.
  for (const [index, entry] of value.layers.entries()) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string') {
      throw new Error(`Project layer ${index + 1} is invalid.`);
    }
    if (ids.has(entry.id)) throw new Error(`Project layer id “${entry.id}” is duplicated.`);
    ids.add(entry.id);
    const width = positiveInteger(entry.width, `layers[${index}].width`);
    const height = positiveInteger(entry.height, `layers[${index}].height`);
    const opacity = finiteNumber(entry.opacity, `layers[${index}].opacity`);
    if (opacity < 0 || opacity > 1 || typeof entry.visible !== 'boolean' || typeof entry.locked !== 'boolean') {
      throw new Error(`Project layer ${index + 1} has invalid properties.`);
    }
    const canvas = await decodeBitmap(entry.bitmap, width, height);
    layers.push({
      id: entry.id,
      name: entry.name,
      canvas,
      width,
      height,
      x: finiteNumber(entry.x, `layers[${index}].x`),
      y: finiteNumber(entry.y, `layers[${index}].y`),
      visible: entry.visible,
      opacity,
      locked: entry.locked,
      ...(typeof entry.protectionSourceId === 'string' && entry.protectionSourceId
        ? { protectionSourceId: entry.protectionSourceId }
        : {}),
      thumbnail: makeThumbnail(canvas),
      ...(entry.stretch === undefined ? {} : { stretch: stretch(entry.stretch) }),
    });
  }

  for (const layer of layers) {
    if (layer.stretch && !ids.has(layer.stretch.sourceLayerId)) {
      throw new Error(`Stretch layer “${layer.name}” refers to a missing source layer.`);
    }
  }
  const selectedLayerId = typeof value.selectedLayerId === 'string' && ids.has(value.selectedLayerId)
    ? value.selectedLayerId
    : layers[layers.length - 1].id;
  return { document: { width: documentWidth, height: documentHeight, layers }, selectedLayerId };
}

export function projectFilename(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  return `PixelStretch-${stamp}.${PROJECT_EXTENSION}`;
}
