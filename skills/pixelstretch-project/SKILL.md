---
name: pixelstretch-project
description: Work on the PixelStretch photo editor repository, including its web UI, layer model, segmentation, stretch rendering, project files, tests, and infrastructure. Use for implementation, debugging, refactoring, or architecture decisions in this repository.
---

# PixelStretch project

Use [references/architecture.md](references/architecture.md) as the repository map and source of architectural invariants.

## Current phase: web first

- Work only on the web application in this phase: `src/`, `public/`, web tests, web scripts, and the Vite/TypeScript/npm configuration.
- Do not implement features or make maintenance changes in the native iOS tree (`Sources/`, `Assets.xcassets/`, `PixelStretch.xcodeproj`, `Info.plist`, or `project.yml`) unless the user explicitly starts or requests the porting phase.
- Treat the current Swift/iOS implementation and `Legacy/` as reference material, not as an active target.
- Prove product behavior, interaction design, rendering, file-format decisions, and tests in the web version first. Port the settled behavior to iOS in a later, separately requested phase.
- Keep portable domain concepts separated from React and browser plumbing when this is natural, but do not build an iOS abstraction or duplicate Swift implementation during the web phase.

## Working rules

- Preserve the local-only product model: imported photos, editing, inference, project save/load, and export happen in the browser. Do not introduce a backend or upload user images without an explicit product decision.
- Place code according to the existing subsystem boundaries described in the architecture reference; avoid growing `EditorScreen.tsx` when logic belongs in layers, rendering, segmentation, project, or utility modules.
- Preserve full-resolution document coordinates and pixels. Viewport scaling is a presentation concern, and analysis downscaling is only for model input.
- Treat saved `.pixelstretch` files as untrusted input. Validate decoded structure and maintain explicit format versioning.
- For a continuous pointer or slider gesture, create one undo snapshot and apply transient updates for the rest of the gesture.
- Keep ML preprocessing and inference off the UI thread. Preserve serialized worker requests and stale-result rejection.

## Verification

Run checks proportional to the change:

- `npm test` for geometry, mask, rendering, and other pure logic.
- `npm run test:e2e` for browser workflows; it uses Chrome, may download model weights, and runs with one worker intentionally.
- `npm run build` for TypeScript and production bundling.
- `npm run lint` for static checks.
- For production-only behavior, start `npm run preview -- --host 127.0.0.1 --port 4173`, then run `node scripts/check-production.mjs`.

