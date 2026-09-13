# ios-stretch — Implementation Plan

One-tap pixel stretch editor: pick photo → subject auto-cut → drag a stretch band
behind the subject in real time → export still or animated clip. Target user is the
Reels/TikTok creator who saw the Photoshop pixel-stretch tutorial and asked
"cool, but how?"

## Tech stack

- **SwiftUI** for the app shell
- **Vision** (`VNGenerateForegroundInstanceMaskRequest`, iOS 17+) for subject segmentation
- **Core Image custom kernel or Metal shader** for the stretch engine
- **AVFoundation** for video export
- No backend, no model training, no third-party ML dependencies — everything on-device

## Architecture (mirrors the prototype exactly)

### Segmentation layer
Input photo → Vision subject lift → soft alpha mask. Interface is just
"image in, alpha mask out," so the model stays swappable (proved in the prototype
when GrabCut substituted for a neural model with zero downstream changes).

- Tap-to-select for multi-subject images — Vision returns per-instance masks, so
  tapping the bike vs. the background rider is built in.
- Manual brush for mask touch-up as the escape hatch.

### Stretch engine
The prototype's `render_stretch` function as a fragment shader: sample a 1px column
at `sample_x`, tile it `length` wide, apply fade ramp and edge softening, rotate
about a pivot glued to the sample line, composite band-over-background then
subject-over-band. One texture sample with clamped coordinates plus two lerps —
trivially 60fps.

Parameters: sample position, vertical extent, length, angle, fade, opacity.

### Editor UX
Every shader parameter maps to a gesture:

- drag the sample line to reposition
- pinch along the band for length
- two-finger rotate for angle
- vertical drag on handles for extent

The pivot-on-sample-line rotation is the detail that makes the band feel attached
to the subject rather than floating. Live preview at screen resolution.

### Export pipeline
Preview edits at ~1080p; export re-runs the shader once at native resolution with
scaled parameters (validated in the prototype: same function, mask upscaled,
params × resolution ratio).

- Still → full-res JPEG/PNG
- Animation → keyframe `length` with cubic ease-out, render frames through the
  same shader, mux with AVAssetWriter to vertical MP4

### Data layer
Non-destructive projects: store original + mask + parameter set. Tiny footprint,
everything re-renderable. SwiftData or plain files.

## Build phases

### Phase 1 — MVP (~3–4 weeks solo)
Photo picker → Vision auto-cut → single stretch band with drag/pinch/rotate →
full-res still export → share sheet. This alone matches the Photoshop tutorial
output.

<!-- Later phases TBD — plan as shared ended at Phase 1. -->
