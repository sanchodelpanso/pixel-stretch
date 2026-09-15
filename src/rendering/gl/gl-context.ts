/**
 * The shared WebGL2 context the band renderer draws with.
 *
 * Everything the GPU renders is copied straight into an ordinary 2D canvas —
 * a GPU-to-GPU copy — so layers, compositing, undo and export keep working on
 * canvases exactly as before. When WebGL2 isn't available, or the context is
 * lost, `getGL` returns null and callers fall back to the CPU renderer.
 */

export interface GL {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** Whether render targets can hold half-float colour, for blur and smear precision. */
  floatTargets: boolean;
}

let shared: GL | null | undefined;
let enabled = true;

/** Turn GPU rendering off (or back on) — for comparing against the CPU renderer. */
export function setGpuRendering(on: boolean): void {
  enabled = on;
}

export function getGL(): GL | null {
  if (!enabled) return null;
  if (shared !== undefined) return shared;
  if (typeof document === 'undefined') return (shared = null);

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    // Outlines antialias in the shaders; multisample resolves on every copy stalled the GPU.
    antialias: false,
    preserveDrawingBuffer: true,
    depth: false,
    stencil: false,
  });
  if (!gl) return (shared = null);

  canvas.addEventListener('webglcontextlost', (event) => {
    // Fall back to the CPU renderer for the rest of the session.
    event.preventDefault();
    shared = null;
    programs.clear();
  });

  // WebGL2 can render to half-float targets only with this extension.
  const floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float'));
  shared = { gl, canvas, floatTargets };
  return shared;
}

// --- Programs ---------------------------------------------------------------

export interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  attributes: Map<string, number>;
}

const programs = new Map<string, Program>();

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader failed to compile: ${log}`);
  }
  return shader;
}

/** Compile (once) and cache a program by name. */
export function program(ctx: GL, name: string, vertex: string, fragment: string): Program {
  const cached = programs.get(name);
  if (cached) return cached;
  const { gl } = ctx;
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program failed to link: ${gl.getProgramInfoLog(p)}`);
  const made: Program = { program: p, uniforms: new Map(), attributes: new Map() };
  programs.set(name, made);
  return made;
}

export function uniform(ctx: GL, p: Program, name: string): WebGLUniformLocation | null {
  if (!p.uniforms.has(name)) p.uniforms.set(name, ctx.gl.getUniformLocation(p.program, name));
  return p.uniforms.get(name)!;
}

export function attribute(ctx: GL, p: Program, name: string): number {
  if (!p.attributes.has(name)) p.attributes.set(name, ctx.gl.getAttribLocation(p.program, name));
  return p.attributes.get(name)!;
}

// --- Textures and targets ---------------------------------------------------

export type Filter = 'linear' | 'nearest';

function configure(gl: WebGL2RenderingContext, filter: Filter): void {
  const f = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/**
 * Upload a canvas as a premultiplied texture. Canvas row 0 becomes texel row 0,
 * so band-local textures keep the sample line at row 0.
 */
export function textureFromCanvas(ctx: GL, source: HTMLCanvasElement, filter: Filter = 'linear'): WebGLTexture {
  const { gl } = ctx;
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  configure(gl, filter);
  return texture;
}

/** Upload straight-alpha RGBA bytes as a premultiplied texture. */
export function textureFromBytes(
  ctx: GL,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  filter: Filter = 'linear',
): WebGLTexture {
  const { gl } = ctx;
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  configure(gl, filter);
  return texture;
}

/** Upload raw floats (RGBA per texel), sampled with `texelFetch`. */
export function textureFromFloats(ctx: GL, data: Float32Array, width: number, height: number): WebGLTexture {
  const { gl } = ctx;
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
  configure(gl, 'nearest');
  return texture;
}

export interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

/** An offscreen colour target, half-float where the GPU supports rendering to it. */
export function createTarget(ctx: GL, width: number, height: number, filter: Filter = 'linear'): Target {
  const { gl } = ctx;
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (ctx.floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  configure(gl, filter);
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  return { texture, framebuffer, width, height };
}

export function deleteTarget(ctx: GL, target: Target): void {
  ctx.gl.deleteFramebuffer(target.framebuffer);
  ctx.gl.deleteTexture(target.texture);
}

/**
 * Bind a target (or the canvas when null), size the viewport, and clear it to
 * transparent. Returns the height fragment shaders flip `gl_FragCoord.y`
 * against to get rows counted from the top.
 *
 * The canvas only ever grows: resizing a WebGL canvas reallocates its
 * multisampled buffers and stalls the GPU, which cost more than the drawing
 * itself. Each render uses its top-left corner, which `copyToCanvas` reads.
 */
export function bindTarget(
  ctx: GL,
  target: Target | null,
  width: number,
  height: number,
  slot: CanvasSlot = { top: 0, reserve: height },
): number {
  const { gl } = ctx;
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  if (target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return height;
  }
  const { canvas } = ctx;
  if (canvas.width < width || canvas.height < Math.max(slot.reserve, slot.top + height)) {
    canvas.width = Math.max(canvas.width, width);
    canvas.height = Math.max(canvas.height, slot.reserve, slot.top + height);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const bottom = canvas.height - slot.top - height;
  gl.viewport(0, bottom, width, height);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, bottom, width, height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return canvas.height - slot.top;
}

/**
 * Where on the GL canvas a render goes: `top` rows down from its top edge,
 * with the canvas grown to at least `reserve` rows so several renders can sit
 * stacked and be copied out after a single GPU flush.
 */
export interface CanvasSlot {
  top: number;
  reserve: number;
}

/** Copy what was just drawn to the GL canvas's top-left corner into a fresh 2D canvas. */
export function copyToCanvas(ctx: GL, width: number, height: number, top = 0): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  out.getContext('2d')!.drawImage(ctx.canvas, 0, top, width, height, 0, 0, width, height);
  return out;
}

/** Whether a texture or target this size fits on this GPU. */
export function fits(ctx: GL, width: number, height: number): boolean {
  const max = ctx.gl.getParameter(ctx.gl.MAX_TEXTURE_SIZE) as number;
  return width >= 1 && height >= 1 && width <= max && height <= max;
}

// --- Geometry -----------------------------------------------------------------

let quad: WebGLBuffer | null = null;
let quadOwner: WebGL2RenderingContext | null = null;

/** Draw a full-viewport quad; the vertex shader receives `a_position` in -1..1. */
export function drawFullscreen(ctx: GL, p: Program): void {
  const { gl } = ctx;
  if (!quad || quadOwner !== gl) {
    quad = gl.createBuffer();
    quadOwner = gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  const location = attribute(ctx, p, 'a_position');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.disableVertexAttribArray(location);
}

export const FULLSCREEN_VERTEX = `#version 300 es
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

/**
 * Shared GLSL: the grid texture, matching `gridEffect` — returns (keep, paint).
 * style 0 = cut, 1 = lines; hasColor 0/1.
 *
 * On a mesh, lines are box-filtered over each pixel's footprint, so they stay
 * smooth where a band is stretched or squeezed — the same softening the canvas
 * renderer gets from sampling its grid texture. `columnRate` and `rowRate` are
 * how many band pixels one screen pixel spans; zero point-samples instead,
 * matching renderers that evaluate the grid exactly per pixel.
 */
export const GRID_GLSL = `
uniform float u_gridStrength;
uniform float u_gridSize;
uniform int u_gridStyle;
uniform int u_gridHasColor;
uniform vec3 u_gridColor;

// Total length of grid line from 0 to x, for lines filling [k*cell - width, k*cell).
float gridLineIntegral(float x, float cell, float width) {
  float k = floor(x / cell);
  return k * width + clamp(x - k * cell - (cell - width), 0.0, width);
}

// How much of the footprint centred on x lies on a line: pixel i spans [i, i + 1).
float gridLineCover(float x, float rate, float cell, float width) {
  if (rate <= 0.0) return mod(floor(x), cell) >= cell - width ? 1.0 : 0.0;
  float halfSpan = max(rate, 1.0) * 0.5;
  return (gridLineIntegral(x + halfSpan, cell, width) - gridLineIntegral(x - halfSpan, cell, width)) / (2.0 * halfSpan);
}

vec2 gridEffect(float column, float row, float columnRate, float rowRate) {
  if (u_gridStrength <= 0.0) return vec2(1.0, 0.0);
  float cell = max(1.0, floor(u_gridSize + 0.5));
  float width = max(1.0, floor(cell / 8.0 + 0.5));
  float across = gridLineCover(column, columnRate, cell, width);
  float along = gridLineCover(row, rowRate, cell, width);
  float line = across + along - across * along;
  if (u_gridStyle == 1) return vec2(u_gridStrength * line, 0.0);
  return u_gridHasColor == 1 ? vec2(1.0, u_gridStrength * line) : vec2(1.0 - u_gridStrength * line, 0.0);
}
`;
