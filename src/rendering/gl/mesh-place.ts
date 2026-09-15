import type { Point } from '../../types/stretch';
import { parseHexColor, type GridOptions } from '../grid-texture';
import {
  attribute, bindTarget, copyToCanvas, GRID_GLSL, program, textureFromBytes, uniform, type CanvasSlot, type GL, type Program,
} from './gl-context';

/** A band surface diced into cells: `points[row][column]` in document space. */
export interface GLMesh {
  cols: number;
  rows: number;
  points: Point[][];
  /** How far each vertex moved from the flat rectangle; folded-over cells draw last. */
  lift: number[][];
}

export interface PixelBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

const VERTEX = `#version 300 es
in vec2 a_position;
in vec2 a_texcoord;
uniform vec2 u_origin;
uniform vec2 u_size;
out vec2 v_texcoord;
void main() {
  vec2 p = (a_position - u_origin) / u_size;
  // Document y runs down; clip space y runs up.
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  v_texcoord = a_texcoord;
}
`;

/**
 * Antialias the band's outline in the shader. The GL canvas skips
 * multisampling — resolving it on every copy cost more than the drawing — so
 * each fragment fades out within half a screen pixel of the band's edge,
 * measured through the local coordinates' screen-space rate of change.
 */
const EDGE_GLSL = `
float edgeCoverage(vec2 uv) {
  vec2 rate = max(fwidth(uv), vec2(1e-6));
  vec2 inside = min(uv, 1.0 - uv) / rate;
  return clamp(min(inside.x, inside.y) + 0.5, 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_texcoord;
uniform sampler2D u_texture;
out vec4 color;
${EDGE_GLSL}
void main() { color = texture(u_texture, v_texcoord) * edgeCoverage(v_texcoord); }
`;

/**
 * Build interleaved (x, y, u, v) vertices and a triangle index list for a mesh.
 * With `sortCells`, cells are ordered by how far they lifted so a folded flap
 * lands on top — only a curved sheet can fold, so flat ones skip the sort.
 */
export function meshGeometry(mesh: GLMesh, sortCells = false): { vertices: Float32Array; indices: Uint32Array } {
  const { cols, rows, points } = mesh;
  const vertices = new Float32Array((cols + 1) * (rows + 1) * 4);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = (j * (cols + 1) + i) * 4;
      vertices[k] = points[j][i].x;
      vertices[k + 1] = points[j][i].y;
      vertices[k + 2] = i / cols;
      vertices[k + 3] = j / rows;
    }
  }
  const order: number[] = [];
  for (let n = 0; n < cols * rows; n++) order.push(n);
  if (sortCells) {
    const { lift } = mesh;
    const cellLift = (n: number) => {
      const i = n % cols;
      const j = Math.floor(n / cols);
      return lift[j][i] + lift[j][i + 1] + lift[j + 1][i] + lift[j + 1][i + 1];
    };
    const lifts = order.map(cellLift);
    order.sort((a, b) => lifts[a] - lifts[b]);
  }
  const indices = new Uint32Array(order.length * 6);
  for (let n = 0; n < order.length; n++) {
    const cell = order[n];
    const a = Math.floor(cell / cols) * (cols + 1) + (cell % cols);
    const b = a + 1;
    const c = a + cols + 1;
    const d = c + 1;
    const k = n * 6;
    indices[k] = a;
    indices[k + 1] = b;
    indices[k + 2] = c;
    indices[k + 3] = b;
    indices[k + 4] = d;
    indices[k + 5] = c;
  }
  return { vertices, indices };
}

/** Draw a mesh with a program whose uniforms are already set, blending premultiplied. */
function drawMesh(ctx: GL, p: Program, mesh: GLMesh, sortCells: boolean): void {
  const { gl } = ctx;
  const { vertices, indices } = meshGeometry(mesh, sortCells);
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STREAM_DRAW);
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STREAM_DRAW);

  const position = attribute(ctx, p, 'a_position');
  const texcoord = attribute(ctx, p, 'a_texcoord');
  gl.enableVertexAttribArray(position);
  gl.enableVertexAttribArray(texcoord);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(texcoord, 2, gl.FLOAT, false, 16, 8);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
  gl.disable(gl.BLEND);
  gl.disableVertexAttribArray(position);
  gl.disableVertexAttribArray(texcoord);
  gl.deleteBuffer(vertexBuffer);
  gl.deleteBuffer(indexBuffer);
}

/**
 * Draw a band-local texture across its mesh into a canvas covering `bounds`.
 * Neighbouring triangles share their edges exactly, so translucent textures
 * leave no seams; the canvas's multisampling antialiases the outline.
 */
export function placeTextureOnMesh(
  ctx: GL,
  texture: WebGLTexture,
  mesh: GLMesh,
  bounds: PixelBounds,
  crisp = false,
  sortCells = false,
): HTMLCanvasElement {
  drawTextureOnMesh(ctx, texture, mesh, bounds, crisp, sortCells);
  return copyToCanvas(ctx, bounds.width, bounds.height);
}

/** Draw a band-local texture across its mesh into a slot of the GL canvas, without copying it out. */
export function drawTextureOnMesh(
  ctx: GL,
  texture: WebGLTexture,
  mesh: GLMesh,
  bounds: PixelBounds,
  crisp = false,
  sortCells = false,
  slot?: CanvasSlot,
): void {
  const { gl } = ctx;
  const p = program(ctx, 'mesh-place', VERTEX, FRAGMENT);
  bindTarget(ctx, null, bounds.width, bounds.height, slot);
  gl.useProgram(p.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const filter = crisp ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.uniform1i(uniform(ctx, p, 'u_texture'), 0);
  gl.uniform2f(uniform(ctx, p, 'u_origin'), bounds.minX, bounds.minY);
  gl.uniform2f(uniform(ctx, p, 'u_size'), bounds.width, bounds.height);
  drawMesh(ctx, p, mesh, sortCells);
}

const ROW_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_texcoord;
uniform sampler2D u_row;
uniform vec2 u_localSize;
uniform float u_fade;
uniform float u_soft;
out vec4 color;
${GRID_GLSL}
${EDGE_GLSL}

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
  // Band-local pixel coordinates, and how many of them one screen pixel spans.
  vec2 local = v_texcoord * u_localSize;
  vec2 rate = fwidth(local);
  float u = clamp(v_texcoord.x, 0.0, 1.0);
  float t = clamp(v_texcoord.y, 0.0, 1.0);
  // Every row of a smooth band is the same row of colours.
  vec4 texel = texture(u_row, vec2(u, 0.5));
  vec2 grid = gridEffect(local.x, local.y, rate.x, rate.y);
  if (u_gridHasColor == 1 && grid.y > 0.0) texel.rgb += (u_gridColor * texel.a - texel.rgb) * grid.y;
  color = texel * (fadeAlong(t) * fadeAcross(u) * grid.x * edgeCoverage(v_texcoord));
}
`;

export interface RowBand {
  /** The sampled row, straight-alpha RGBA, `columns` wide. */
  row: Uint8ClampedArray;
  columns: number;
  /** The band's local size in pixels, which grid lines are measured in. */
  localWidth: number;
  localHeight: number;
  fade: number;
  /** Edge softening, already clamped to 0–0.49. */
  soft: number;
  grid: GridOptions;
}

/**
 * Draw a smooth band straight from its sampled row: the fragment shader
 * extrudes the row, fades and softens it and cuts the grid, so no band-sized
 * bitmap is built on the CPU or uploaded.
 */
export function placeRowOnMesh(
  ctx: GL,
  band: RowBand,
  mesh: GLMesh,
  bounds: PixelBounds,
  sortCells = false,
): HTMLCanvasElement {
  const { gl } = ctx;
  const p = program(ctx, 'mesh-row', VERTEX, ROW_FRAGMENT);
  const rowTexture = textureFromBytes(ctx, band.row, band.columns, 1, 'linear');
  bindTarget(ctx, null, bounds.width, bounds.height);
  gl.useProgram(p.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, rowTexture);
  const set = (name: string) => uniform(ctx, p, name);
  gl.uniform1i(set('u_row'), 0);
  gl.uniform2f(set('u_origin'), bounds.minX, bounds.minY);
  gl.uniform2f(set('u_size'), bounds.width, bounds.height);
  gl.uniform2f(set('u_localSize'), band.localWidth, band.localHeight);
  gl.uniform1f(set('u_fade'), band.fade);
  gl.uniform1f(set('u_soft'), band.soft);
  const gridColor = parseHexColor(band.grid.color);
  gl.uniform1f(set('u_gridStrength'), band.grid.strength);
  gl.uniform1f(set('u_gridSize'), band.grid.size);
  gl.uniform1i(set('u_gridStyle'), band.grid.style === 'lines' ? 1 : 0);
  gl.uniform1i(set('u_gridHasColor'), gridColor ? 1 : 0);
  gl.uniform3f(set('u_gridColor'), (gridColor?.[0] ?? 0) / 255, (gridColor?.[1] ?? 0) / 255, (gridColor?.[2] ?? 0) / 255);
  drawMesh(ctx, p, mesh, sortCells);
  gl.deleteTexture(rowTexture);
  return copyToCanvas(ctx, bounds.width, bounds.height);
}
