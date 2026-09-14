---
name: mobile-first-ui
description: PixelStretch is a mobile-first editor (web app in src/ and the iOS port). Use whenever adding, moving or redesigning any editor control, tool, mode, panel entry or gesture — it decides where the control lives and how it is operated.
---

# Mobile-first editor controls

PixelStretch is used mainly on phones. Design every control for a thumb on a
small screen first; desktop gets the same controls, not extra ones. Canva's
mobile app is the reference: editing happens on the object, with a small,
contextual set of controls — not in panels beside it.

## Where a control goes

1. **On the canvas, next to what it edits.** Handles, mode icons and quick
   toggles sit on or beside the selected object (e.g. the lock, curve and
   △ edge buttons beside a stretch band). This is the default.
2. **A compact contextual bar** along the bottom of the editor area, only
   for the current tool or selection, when on-object space runs out.
3. **The right/bottom-sheet panel is last resort** — layer list and precise
   numeric values only. Don't add new panels, rows or button groups there
   for things a canvas control can do. When a feature gets a canvas control,
   remove its panel duplicate.

## How it is operated

- **Tap and drag only.** No double-click, right-click, hover-only
  affordances or keyboard-only actions as the sole path to a feature.
  Keyboard shortcuts are fine as extras.
- **Modes over hidden gestures.** An action that would need a special gesture
  (removing a vertex, adding a knot) becomes a toggle icon that switches the
  handles into tap targets, as with the edge mode on straight bands. While a
  mode is on, hide handles that would compete with it.
- **Finger-sized targets.** At least 44 pt of hit area, even when the visible
  marker is small (use a transparent hit circle).
- **Few controls at once.** Show only what applies to the current selection
  and tool; everything else stays hidden until relevant.
- **Always reversible on the spot.** The control that did something can undo
  it (tap again, restore marker), besides global undo.

## Before finishing a UI change

- Check it at phone width (~390 px wide) as well as desktop.
- Confirm nothing new landed in the side panel that could live on the canvas.
- On behaviour vs pixels between web and iOS, match behaviour (see memory).
