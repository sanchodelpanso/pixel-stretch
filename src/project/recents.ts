import type { SourceImage } from '../types/image';
import type { LayerDocument } from '../types/layer';
import { createCanvas } from '../layers/layer-utils';
import { drawDocumentLayers } from '../layers/compositor';
import { decodeProject, type LoadedProject } from './project-file';

/**
 * Recently opened images and saved projects, kept in the browser.
 *
 * An image entry holds only the original picture — edits made on top of it are
 * never persisted. A project entry is written only when the user saves, and
 * holds the full layer stack.
 */
export interface RecentEntry {
  id: string;
  kind: 'image' | 'project';
  name: string;
  width: number;
  height: number;
  /** Epoch milliseconds of the last open (images) or save (projects). */
  updatedAt: number;
  /** Small JPEG data URL. */
  thumbnail: string;
  layerCount?: number;
}

export class RecentStorageFullError extends Error {
  constructor() {
    super('Browser storage is full.');
    this.name = 'RecentStorageFullError';
  }
}

const MAX_PER_KIND = 6;
const THUMBNAIL_SIZE = 320;
const INDEX_KEY = 'index';

// --- Backends ----------------------------------------------------------------

interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException
    && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

/** Synchronous and small (~5 MB), but trivial to inspect in devtools during local work. */
function localStorageStore(prefix: string): KeyValueStore {
  return {
    get: async (key) => localStorage.getItem(prefix + key),
    set: async (key, value) => {
      try {
        localStorage.setItem(prefix + key, value);
      } catch (err) {
        throw isQuotaError(err) ? new RecentStorageFullError() : err;
      }
    },
    remove: async (key) => localStorage.removeItem(prefix + key),
  };
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function indexedDbStore(name: string): KeyValueStore {
  const STORE = 'kv';
  let db: Promise<IDBDatabase> | null = null;
  const open = () => {
    db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return db;
  };
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
    const store = (await open()).transaction(STORE, mode).objectStore(STORE);
    try {
      return await idbRequest(action(store));
    } catch (err) {
      throw isQuotaError(err) ? new RecentStorageFullError() : err;
    }
  };
  return {
    get: async (key) => (await run('readonly', (store) => store.get(key))) ?? null,
    set: async (key, value) => { await run('readwrite', (store) => store.put(value, key)); },
    remove: async (key) => { await run('readwrite', (store) => store.delete(key)); },
  };
}

function isLocalhost(): boolean {
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
}

const store: KeyValueStore = isLocalhost()
  ? localStorageStore('pixelstretch.recents.')
  : indexedDbStore('pixelstretch-recents');

// --- Index -------------------------------------------------------------------

const payloadKey = (id: string) => `item:${id}`;

async function readIndex(): Promise<RecentEntry[]> {
  try {
    const raw = await store.get(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

const writeIndex = (entries: RecentEntry[]) => store.set(INDEX_KEY, JSON.stringify(entries));

/** Index and payloads change together, so every mutation runs one at a time. */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

/**
 * Write an entry's payload and put the entry at the top of the index. When the
 * store is full, the oldest other entries are evicted until it fits.
 */
async function putEntry(entry: RecentEntry, payload: string | null): Promise<void> {
  let entries = (await readIndex()).filter((item) => item.id !== entry.id);
  const evictOldest = async () => {
    const victim = [...entries].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!victim) return false;
    entries = entries.filter((item) => item !== victim);
    await store.remove(payloadKey(victim.id));
    await writeIndex(entries);
    return true;
  };

  if (payload !== null) {
    for (;;) {
      try {
        await store.set(payloadKey(entry.id), payload);
        break;
      } catch (err) {
        if (!(err instanceof RecentStorageFullError) || !(await evictOldest())) throw err;
      }
    }
  }

  entries.unshift(entry);
  const sameKind = entries.filter((item) => item.kind === entry.kind);
  for (const stale of sameKind.slice(MAX_PER_KIND)) {
    entries = entries.filter((item) => item !== stale);
    await store.remove(payloadKey(stale.id));
  }
  for (;;) {
    try {
      await writeIndex(entries);
      return;
    } catch (err) {
      if (!(err instanceof RecentStorageFullError) || !(await evictOldest())) throw err;
    }
  }
}

// --- Encoding helpers --------------------------------------------------------

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed'))), type, quality);
  });
}

function thumbnailCanvas(width: number, height: number, draw: (ctx: CanvasRenderingContext2D, scale: number) => void): string {
  const scale = Math.min(THUMBNAIL_SIZE / width, THUMBNAIL_SIZE / height, 1);
  const canvas = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  draw(ctx, scale);
  return canvas.toDataURL('image/jpeg', 0.8);
}

const baseName = (filename: string) => filename.replace(/\.[^.]+$/, '') || filename;

// --- Public API --------------------------------------------------------------

export function listRecents(): Promise<RecentEntry[]> {
  return serialized(async () => (await readIndex()).sort((a, b) => b.updatedAt - a.updatedAt));
}

export function imageRecentId(file: File): string {
  return `image-${file.name}-${file.size}-${file.lastModified}`;
}

/**
 * Remember an opened image. Only the original file is stored; if it cannot fit
 * even with older entries evicted, a re-encoded copy is tried before giving up.
 */
export function rememberImage(file: File, image: SourceImage, id = imageRecentId(file)): Promise<void> {
  return serialized(async () => {
    const existing = (await readIndex()).find((item) => item.id === id);
    const entry: RecentEntry = existing
      ? { ...existing, updatedAt: Date.now() }
      : {
          id,
          kind: 'image',
          name: baseName(file.name),
          width: image.width,
          height: image.height,
          updatedAt: Date.now(),
          thumbnail: thumbnailCanvas(image.width, image.height, (ctx, scale) => {
            ctx.drawImage(image, 0, 0, image.width * scale, image.height * scale);
          }),
        };
    if (existing) return putEntry(entry, null);

    const payload = JSON.stringify({ name: file.name, type: file.type, lastModified: file.lastModified, data: await blobToDataUrl(file) });
    try {
      await putEntry(entry, payload);
    } catch (err) {
      if (!(err instanceof RecentStorageFullError)) throw err;
      const canvas = createCanvas(image.width, image.height);
      canvas.getContext('2d')!.drawImage(image, 0, 0);
      const opaque = /jpe?g|heic|heif/i.test(file.type || file.name);
      const blob = await canvasToBlob(canvas, opaque ? 'image/jpeg' : 'image/webp', 0.9);
      await putEntry(entry, JSON.stringify({ name: file.name, type: blob.type, lastModified: file.lastModified, data: await blobToDataUrl(blob) }));
    }
  });
}

export function loadRecentImage(id: string): Promise<File> {
  return serialized(async () => {
    const raw = await store.get(payloadKey(id));
    if (!raw) throw new Error('This recent image is no longer stored.');
    const { name, type, lastModified, data } = JSON.parse(raw) as { name: string; type: string; lastModified: number; data: string };
    const blob = await (await fetch(data)).blob();
    return new File([blob], name, { type: type || blob.type, lastModified });
  });
}

/**
 * Store a saved project, replacing `id` when it was saved before.
 * Returns the id to use for the next save of the same document.
 */
export function rememberProject(
  id: string | null,
  name: string,
  document: LayerDocument,
  projectBlob: Blob,
): Promise<string> {
  return serialized(async () => {
    const entryId = id ?? `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await putEntry(
      {
        id: entryId,
        kind: 'project',
        name,
        width: document.width,
        height: document.height,
        updatedAt: Date.now(),
        layerCount: document.layers.length,
        thumbnail: thumbnailCanvas(document.width, document.height, (ctx, scale) => {
          ctx.scale(scale, scale);
          drawDocumentLayers(ctx, document);
        }),
      },
      await projectBlob.text(),
    );
    return entryId;
  });
}

export function loadRecentProject(id: string): Promise<LoadedProject> {
  return serialized(async () => {
    const raw = await store.get(payloadKey(id));
    if (!raw) throw new Error('This saved project is no longer stored.');
    return decodeProject(new Blob([raw]));
  });
}

export function removeRecent(id: string): Promise<void> {
  return serialized(async () => {
    await store.remove(payloadKey(id));
    await writeIndex((await readIndex()).filter((item) => item.id !== id));
  });
}

export function projectNameFromFile(file: File): string {
  return baseName(file.name);
}
