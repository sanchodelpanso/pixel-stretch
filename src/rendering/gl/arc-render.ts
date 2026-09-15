import type { ArcBand } from '../../types/arc-band';
import { parseHexColor, type GridOptions } from '../grid-texture';
import {
  bindTarget, copyToCanvas, drawFullscreen, FULLSCREEN_VERTEX, GRID_GLSL, program, textureFromFloats, uniform,
  type CanvasSlot, type GL,
} from './gl-context';
import type { PixelBounds } from './mesh-place';

/**
 * How the arc reads its texture at a point `position` columns across and `t`
 * of the way round:
 * - `row`: one sampled row, blended between neighbouring columns (smooth style).
 * - `streaks`: an unrolled band texture, nearest texel (pixel and motion styles).
 * - `local`: an unrolled band texture, filtered (melt textures).
 */
export type ArcTextureMode = 'row' | 'streaks' | 'local';

export interface ArcRender {
  arc: ArcBand;
  /** Radial thickness, in document pixels. */
  width: number;
  /** Columns across the band's texture. */
  columns: number;
  texture: WebGLTexture;
  /** Texture height in texels (1 for `row`). */
  textureLength: number;
  mode: ArcTextureMode;
  /** Edge radii tables from `arcEdgeTables`, sampled at `samples + 1` points round the sweep. */
  inner: Float64Array;
  outer: Float64Array;
  fade: number;
  /** Edge softening, already clamped to 0–0.49. */
  soft: number;
  grid: GridOptions;
  bounds: PixelBounds;
}

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_origin;
uniform float u_height;
uniform vec2 u_centre;
uniform float u_angle;
uniform float u_sweep;
uniform bool u_closed;
uniform bool u_outward;
uniform float u_columns;
uniform float u_arcLength;
uniform sampler2D u_texture;
uniform float u_textureLength;
uniform int u_mode;
uniform highp sampler2D u_tables;
uniform float u_samples;
uniform float u_fade;
uniform float u_soft;
out vec4 color;

const float TAU = 6.28318530717958647692;
${GRID_GLSL}

float sampleTable(int channel, float t) {
  float position = clamp(t, 0.0, 1.0) * u_samples;
  float i = min(u_samples - 1.0, floor(position));
  float a = texelFetch(u_tables, ivec2(int(i), 0), 0)[channel];
  float b = texelFetch(u_tables, ivec2(int(i) + 1, 0), 0)[channel];
  return a + (b - a) * (position - i);
}

float fadeAlong(float t) {
  float far = clamp(1.0 - u_fade, 0.0, 1.0);
  if (u_soft <= 0.0) return 1.0 + (far - 1.0) * t;
  float knee = 1.0 - u_soft;
  return t < knee ? 1.0 + (far - 1.0) * (t / knee) : far * (1.0 - (t - knee) / u_soft);
}

float fadeAcross(float u) {
  if (u_soft <= 0.0) return 1.0;
  return min(1.0, min(u / u_soft, (1.0 - u) / u_soft));
}

void main() {
  vec2 point = vec2(u_origin.x + gl_FragCoord.x, u_origin.y + (u_height - gl_FragCoord.y));
  vec2 d = point - u_centre;
  float r = length(d);
  float span = abs(u_sweep);
  float direction = u_sweep < 0.0 ? -1.0 : 1.0;

  float travelled = mod((atan(d.y, d.x) - u_angle) * direction, TAU);
  if (travelled < 0.0) travelled += TAU;

  float coverage = 1.0;
  if (!u_closed) {
    if (travelled > span) {
      float pastEnd = (travelled - span) * r;
      float beforeStart = (TAU - travelled) * r;
      float edge = 0.5 - min(pastEnd, beforeStart);
      if (edge <= 0.0) discard;
      coverage = edge;
      travelled = pastEnd < beforeStart ? span : 0.0;
    } else {
      coverage = min(1.0, min(travelled * r + 0.5, (span - travelled) * r + 0.5));
    }
  }

  float t = span > 0.0 ? travelled / (u_closed ? TAU : span) : 0.0;
  float inner = sampleTable(0, t);
  float outer = sampleTable(1, t);
  float thickness = outer - inner;
  if (thickness < 1e-3) discard;
  float radial = min(1.0, min(r - inner + 0.5, outer - r + 0.5));
  if (radial <= 0.0) discard;

  float across = clamp((r - inner) / thickness, 0.0, 1.0);
  float u = u_outward ? across : 1.0 - across;
  float position = u * (u_columns - 1.0);
  // The canvas arc renderer evaluates the grid exactly per pixel, so point-sample to match.
  vec2 grid = gridEffect(position, t * u_arcLength, 0.0, 0.0);
  float alpha = coverage * radial * fadeAlong(t) * fadeAcross(u) * grid.x;

  vec4 texel;
  if (u_mode == 0) {
    texel = texture(u_texture, vec2((position + 0.5) / u_columns, 0.5));
  } else if (u_mode == 1) {
    int column = int(min(u_columns - 1.0, floor(position + 0.5)));
    int row = int(min(u_textureLength - 1.0, floor(t * u_textureLength)));
    texel = texelFetch(u_texture, ivec2(column, row), 0);
  } else {
    texel = texture(u_texture, vec2((position + 0.5) / u_columns, t));
  }
  if (u_gridHasColor == 1 && grid.y > 0.0) texel.rgb += (u_gridColor * texel.a - texel.rgb) * grid.y;
  color = texel * alpha;
}
`;

/** Render an arc band (or an arc melt texture) into a canvas covering its bounds. */
export function renderArcOnGL(ctx: GL, input: ArcRender): HTMLCanvasElement {
  drawArcOnGL(ctx, input);
  return copyToCanvas(ctx, input.bounds.width, input.bounds.height);
}

/** Draw an arc band into a slot of the GL canvas, without copying it out. */
export function drawArcOnGL(ctx: GL, input: ArcRender, slot?: CanvasSlot): void {
  const { gl } = ctx;
  const { arc, bounds } = input;
  const p = program(ctx, 'arc-band', FULLSCREEN_VERTEX, FRAGMENT);
  const flipHeight = bindTarget(ctx, null, bounds.width, bounds.height, slot);
  gl.useProgram(p.program);

  const samples = input.inner.length - 1;
  const tables = new Float32Array((samples + 1) * 4);
  for (let i = 0; i <= samples; i++) {
    tables[i * 4] = input.inner[i];
    tables[i * 4 + 1] = input.outer[i];
  }
  const tableTexture = textureFromFloats(ctx, tables, samples + 1, 1);

  const centre = { x: arc.origin.x - Math.cos(arc.angle) * arc.radius, y: arc.origin.y - Math.sin(arc.angle) * arc.radius };
  const set = (name: string) => uniform(ctx, p, name);
  gl.uniform2f(set('u_origin'), bounds.minX, bounds.minY);
  gl.uniform1f(set('u_height'), flipHeight);
  gl.uniform2f(set('u_centre'), centre.x, centre.y);
  gl.uniform1f(set('u_angle'), arc.angle);
  gl.uniform1f(set('u_sweep'), arc.sweep);
  gl.uniform1i(set('u_closed'), Math.abs(arc.sweep) >= Math.PI * 2 - 1e-9 ? 1 : 0);
  gl.uniform1i(set('u_outward'), arc.outward ? 1 : 0);
  gl.uniform1f(set('u_columns'), input.columns);
  gl.uniform1f(set('u_arcLength'), Math.abs(arc.sweep) * arc.radius);
  gl.uniform1f(set('u_textureLength'), input.textureLength);
  gl.uniform1i(set('u_mode'), input.mode === 'row' ? 0 : input.mode === 'streaks' ? 1 : 2);
  gl.uniform1f(set('u_samples'), samples);
  gl.uniform1f(set('u_fade'), input.fade);
  gl.uniform1f(set('u_soft'), input.soft);

  const gridColor = parseHexColor(input.grid.color);
  gl.uniform1f(set('u_gridStrength'), input.grid.strength);
  gl.uniform1f(set('u_gridSize'), input.grid.size);
  gl.uniform1i(set('u_gridStyle'), input.grid.style === 'lines' ? 1 : 0);
  gl.uniform1i(set('u_gridHasColor'), gridColor ? 1 : 0);
  gl.uniform3f(set('u_gridColor'), (gridColor?.[0] ?? 0) / 255, (gridColor?.[1] ?? 0) / 255, (gridColor?.[2] ?? 0) / 255);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, input.texture);
  gl.uniform1i(set('u_texture'), 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tableTexture);
  gl.uniform1i(set('u_tables'), 1);

  drawFullscreen(ctx, p);
  gl.deleteTexture(tableTexture);
  gl.activeTexture(gl.TEXTURE0);
}
