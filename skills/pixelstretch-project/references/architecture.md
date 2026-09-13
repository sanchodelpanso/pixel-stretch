# PixelStretch infrastructure and architecture

## Product and phase boundary

PixelStretch is a local-first photo editor that imports an image, selects or lifts subjects, creates editable pixel-stretch layers, saves non-destructive projects, and exports flattened images.

The active implementation is the React web application. Native iOS is a later port target. During the current phase, changes belong to the web tree; do not keep the Swift tree in lockstep.

## Runtime and infrastructure

| Concern | Current choice | Operational implication |
| --- | --- | --- |
| Application | React 19 + TypeScript 6 | UI and orchestration live in `src/components/` and hooks. |
| Build/dev server | Vite 8 | `npm run dev` serves development; `npm run build` emits static assets to `dist/`. |
| Supported working environment | Node.js 24+ and Chrome | Browser E2E tests explicitly use the Chrome channel. |
| Rendering | Browser Canvas 2D | Preview, layer composition, stretch generation, and full-resolution export stay client-side. |
| ML runtime | Transformers.js + ONNX Runtime Web | Models load on demand from Hugging Face and are cached by the browser. WebGPU is attempted first and WASM is the fallback. |
| Persistence | Browser downloads/uploads | `.pixelstretch` is a self-contained, versioned JSON document with embedded PNG layer bitmaps; there is no server database. |
| Backend | None | Photos and project data remain on-device. Do not add network storage or image upload implicitly. |
| Unit tests | Node's test runner | Tests under `tests/unit/` cover portable logic. |
| Browser tests | Playwright | Tests under `tests/` exercise the real Chrome app and segmentation models; one worker avoids model/session contention. |
| Static analysis | TypeScript build + Oxlint | Use `npm run build` and `npm run lint`. |

`public/` contains static web assets. `scripts/` contains production smoke and model-comparison/evaluation tooling. `artifacts/` holds checked-in visual and segmentation evidence; ordinary generated build output is in `dist/`.

## System flow

```text
JPEG / PNG / WebP / HEIC          .pixelstretch project
             |                             |
             v                             v
      image-utils / heic             project-file decode
             |                             |
             +------------+----------------+
                          v
                 LayerDocument state
                    (use-layers)
                          |
          +---------------+----------------+
          |               |                |
          v               v                v
   segmentation       stretch engine    layer compositor
   worker + masks     Canvas 2D output   preview / export
          |               |                |
          +------ extracted/protected -----+
                     layers
                          |
                          v
             project save or image export
```

## Source boundaries

- `src/App.tsx`: switches between import and editor screens; accepts either an image or a decoded project.
- `src/components/`: screen composition, panels, toolbar, and interaction orchestration. `EditorScreen.tsx` coordinates subsystems but should not become the home of reusable rendering, layer, mask, or serialization logic.
- `src/editor/`: canvas-facing interaction and overlay components, including brush input, selection display, sample-path editing, and stretch handles.
- `src/layers/`: `LayerDocument` state, undo/redo, layer operations, subject protection/blending, hit testing, and flattening/compositing.
- `src/rendering/`: framework-independent stretch geometry and Canvas 2D raster generation. Paths are resampled into strips, then mapped through straight, projected, or curved surface geometry.
- `src/segmentation/`: model loading, preprocessing, inference worker protocol, masks, and the React hook that rejects stale results.
- `src/project/`: versioned `.pixelstretch` serialization and defensive decoding.
- `src/types/`: shared domain types for images, layers, selections, and stretch specifications.
- `src/utils/`: image/HEIC import, downloads/exports, and small math helpers.

The native port is isolated in `Sources/` with Xcode resources/configuration at the repository root. `Legacy/` is historical reference code. Neither is an active implementation surface in the web phase.

## Core data model

`LayerDocument` is the editor source of truth: full-resolution canvas width and height plus a bottom-first layer array. Each layer owns an HTML canvas, document-space position, dimensions, visibility, opacity, lock state, and optional stretch metadata.

Important invariants:

- Store geometry in document coordinates, independent of the fitted viewport size.
- Preserve original/full-resolution pixels for project saves and exports. Segmentation may use an analysis image bounded to 1536 pixels on its longest side; map the resulting mask back to layer/document space.
- Layer order is bottom-first everywhere: state, rendering, and project files.
- Document history may share canvas objects because edits construct new layer objects/canvases instead of mutating historical pixel buffers in place.
- The undo history is capped at 30 entries. A continuous gesture is one history action.
- A generated stretch records its `sourceLayerId`, so project decoding must reject references to missing layers.
- A protected stretch lifts the subject and inserts the stretch underneath it as one atomic undoable operation. Reuse an existing protected subject layer when present.

## Segmentation architecture

`use-segmentation.ts` owns UI-facing state and lazily creates `segmentation.worker.ts`. The worker serializes every request so a SlimSAM embedding cannot be paired with prompts for another image. Request IDs ensure late responses cannot overwrite newer tool/layer state.

- Auto selection: `studioludens/birefnet-lite-512`, 512×512 preprocessing, sigmoid mask.
- Tap/brush selection: `Xenova/slimsam-77-uniform`; tap produces point prompts and brush produces a box prompt.
- Model precision is fp32. Try WebGPU first; fall back to WASM when adapter, load, or supported inference fallback logic fails.
- Model loading is lazy and must not block initial photo import.
- Mask coordinates belong to the layer used for inference. A selection is valid only while that layer remains active.

## Rendering and composition

The stretch specification contains the sampled path, source-layer link, band rectangle, rotation, fade, edge softness, bend, and optional corner/edge warp controls. Geometry helpers live in `src/types/stretch.ts`; path sampling, projection, surfaces, and rasterization live in `src/rendering/`.

`renderStretchBand` samples pixels from the source layer, shapes alpha, and renders either a direct transform, projected columns, or a curved patch mesh. It returns a new canvas and its document-space origin. Layer utilities turn this into a normal generated layer and re-render it when its spec changes.

Preview and export share the same document compositor. Subject edge blending must therefore remain consistent for live display, flattened export, and reopened projects. Preserve source pixels so repeated save/open cycles do not compound feathering.

## Project format and trust boundary

`src/project/project-file.ts` defines format `com.pixelstretch.project`, currently version 1. Each layer bitmap is PNG encoded and embedded as base64 in JSON. Encoding and decoding are sequential to bound full-resolution memory spikes.

On decode, validate the outer format/version, canvas bounds, layer count, unique IDs, numeric ranges, bitmap media type, stretch shape, and source-layer references before publishing the document to React state. A format change that cannot be read as version 1 requires a deliberate version/migration decision and tests.

## Testing map

- Put deterministic geometry, masking, blending, and file-independent rendering regressions in `tests/unit/`.
- Put user-visible import, tool, layer, save/open, export, model-loading, and stale-request behavior in Playwright specs under `tests/`.
- Preserve full-resolution and transparency assertions when changing import, masks, composition, or export.
- Model-backed E2E runs can be slow on a cold cache and require network access for the first model download.
