import type { EdgeWarp, StretchSpec, Warp } from './stretch.ts';
import { NO_EDGE_WARP, NO_WARP } from './stretch.ts';

export type BendPreset = 'flat' | 'cylinder' | 'arc-left' | 'arc-right' | 's-curve' | 'taper';

const copyEdges = (): EdgeWarp => NO_EDGE_WARP.map((edge) => (
  edge.map((control) => ({ ...control }))
)) as EdgeWarp;

const copyWarp = (): Warp => NO_WARP.map((offset) => ({ ...offset })) as Warp;

/**
 * Build a coherent 3D-bend setup from one tap. The values are relative to the
 * band's own width, so the presets feel the same on small and large projects.
 */
export function bendPreset(spec: StretchSpec, preset: BendPreset): Partial<StretchSpec> {
  const width = Math.max(1, Math.abs(spec.width));
  const edges = copyEdges();
  const warp = copyWarp();

  if (preset === 'flat') {
    return { bend: 0, warpMode: 'straight', edges, warp };
  }

  if (preset === 'cylinder') {
    return { bend: 1, warpMode: 'straight', edges, warp };
  }

  if (preset === 'taper') {
    const inset = width * 0.24;
    warp[2] = { u: -inset, v: 0 };
    warp[3] = { u: inset, v: 0 };
    return { bend: 0.85, warpMode: 'straight', edges, warp };
  }

  if (preset === 's-curve') {
    const amount = width * 0.22;
    // Edge 3 travels in the opposite direction, so its controls are reversed.
    edges[1] = [{ u: amount, v: 0 }, { u: -amount, v: 0 }];
    edges[3] = [{ u: -amount, v: 0 }, { u: amount, v: 0 }];
    return { bend: 0.6, warpMode: 'curved', edges, warp };
  }

  const direction = preset === 'arc-left' ? -1 : 1;
  const amount = width * 0.28 * direction;
  const farInset = width * 0.1;
  edges[1] = [{ u: amount, v: 0 }, { u: amount, v: 0 }];
  edges[3] = [{ u: amount, v: 0 }, { u: amount, v: 0 }];
  warp[2] = { u: -farInset, v: 0 };
  warp[3] = { u: farInset, v: 0 };
  return { bend: 0.75, warpMode: 'curved', edges, warp };
}
