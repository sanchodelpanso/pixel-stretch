import type { ArcBand } from '../../types/arc-band';
import type { Layer } from '../../types/layer';
import { drawArcOnGL } from './arc-render';
import {
  attribute, bindTarget, copyToCanvas, createTarget, deleteTarget, drawFullscreen, fits, FULLSCREEN_VERTEX, program,
  textureFromCanvas, textureFromFloats, uniform, type CanvasSlot, type GL, type Target,
} from './gl-context';
import { drawTextureOnMesh, meshGeometry, type GLMesh, type PixelBounds } from './mesh-place';

/** Most texture reads averaged per smeared pixel; longer windows are sampled evenly. */
const SMEAR_TAPS = 64;

export interface MeltInput {
  subject: Layer;
  /** Streaks across the band, and its length along them, in band pixels. */
  columns: number;
  length: number;
  /** Per streak: where its melt starts, its side feather, and its smear rate. */
  wander: Float32Array;
  side: Float32Array;
  rate: Float32Array;
  /** Handover length from subject to smear. */
  ramp: number;
  /** Where the band runs through the document. */
  geometry:
    | { kind: 'mesh'; mesh: GLMesh; bounds: PixelBounds; curved: boolean }
    | { kind: 'arc'; arc: ArcBand; width: number; inner: Float64Array; outer: Float64Array; bounds: PixelBounds };
}

const RESAMPLE_MESH_VERTEX = `#version 300 es
in vec2 a_position;
in vec2 a_texcoord;
uniform vec2 u_local;
uniform vec2 u_subjectOrigin;
uniform vec2 u_subjectSize;
out vec2 v_subject;
void main() {
  // Lay the mesh out in band-local texels; carry each vertex's document position as a subject texcoord.
  vec2 local = a_texcoord * u_local;
  gl_Position = vec4(local / u_local * 2.0 - 1.0, 0.0, 1.0);
  v_subject = (a_position - u_subjectOrigin) / u_subjectSize;
}
`;

const RESAMPLE_MESH_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_subject;
uniform sampler2D u_subject;
out vec4 color;
void main() {
  bool inside = all(greaterThanEqual(v_subject, vec2(0.0))) && all(lessThanEqual(v_subject, vec2(1.0)));
  color = inside ? texture(u_subject, v_subject) : vec4(0.0);
}
`;

const RESAMPLE_ARC_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_subject;
uniform vec2 u_subjectOrigin;
uniform vec2 u_subjectSize;
uniform vec2 u_local;
uniform vec2 u_centre;
uniform float u_angle;
uniform float u_sweep;
uniform float u_radius;
uniform float u_width;
uniform bool u_outward;
out vec4 color;
void main() {
  // Column x runs across the ring from whichever edge the path started on.
  float across = gl_FragCoord.x / u_local.x;
  float offset = (u_outward ? across : 1.0 - across) * u_width - u_width / 2.0;
  float theta = u_angle + u_sweep * (gl_FragCoord.y / u_local.y);
  vec2 point = u_centre + vec2(cos(theta), sin(theta)) * (u_radius + offset);
  vec2 uv = (point - u_subjectOrigin) / u_subjectSize;
  bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  color = inside ? texture(u_subject, uv) : vec4(0.0);
}
`;

const SMEAR_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_resampled;
uniform highp sampler2D u_params;
uniform float u_length;
uniform float u_ramp;
uniform bool u_eraseOnly;
out vec4 color;
void main() {
  int x = int(gl_FragCoord.x);
  float y = floor(gl_FragCoord.y);
  vec4 params = texelFetch(u_params, ivec2(x, 0), 0);
  float wander = params.r;
  float side = params.g;
  float rate = params.b;

  float amount = side * smoothstep(0.0, 1.0, (y + 0.5 - wander) / u_ramp);
  if (amount <= 0.0) { color = vec4(0.0); return; }
  if (u_eraseOnly) { color = vec4(0.0, 0.0, 0.0, amount); return; }

  // Average the pixels behind this one over a window that grows past the melt's start.
  float reach = max(0.0, y - wander) * rate;
  float from = max(0.0, floor(y - reach));
  float n = y - from + 1.0;
  vec4 sum = vec4(0.0);
  if (n <= ${SMEAR_TAPS}.0) {
    for (int k = 0; k < ${SMEAR_TAPS}; k++) {
      if (float(k) >= n) break;
      sum += texelFetch(u_resampled, ivec2(x, int(from) + k), 0);
    }
    sum /= n;
  } else {
    float u = (float(x) + 0.5) / float(textureSize(u_resampled, 0).x);
    for (int k = 0; k < ${SMEAR_TAPS}; k++) {
      float row = from + (float(k) + 0.5) * n / ${SMEAR_TAPS}.0;
      sum += texture(u_resampled, vec2(u, row / u_length));
    }
    sum /= ${SMEAR_TAPS}.0;
  }
  color = sum * amount;
}
`;

/** Subject textures, reused while the subject's pixels stay the same. */
const subjectTextures = new Map<HTMLCanvasElement, WebGLTexture>();
const MAX_SUBJECT_TEXTURES = 4;

function subjectTexture(ctx: GL, canvas: HTMLCanvasElement): WebGLTexture {
  const cached = subjectTextures.get(canvas);
  if (cached) return cached;
  if (subjectTextures.size >= MAX_SUBJECT_TEXTURES) {
    const [oldest, texture] = subjectTextures.entries().next().value!;
    ctx.gl.deleteTexture(texture);
    subjectTextures.delete(oldest);
  }
  const texture = textureFromCanvas(ctx, canvas, 'linear');
  subjectTextures.set(canvas, texture);
  return texture;
}

/**
 * Melt a subject into a band on the GPU: resample the subject along the band
 * into band-local texels, smear each streak over its growing window, and place
 * the smear and its erase mask back into the document. Null when it can't run.
 */
export function meltOnGL(ctx: GL, input: MeltInput): { erase: HTMLCanvasElement; smear: HTMLCanvasElement } | null {
  const { columns, length, subject, geometry } = input;
  const { bounds } = geometry;
  if (!fits(ctx, columns, length) || !fits(ctx, bounds.width, bounds.height * 2) || !fits(ctx, subject.width, subject.height)) {
    return null;
  }
  const { gl } = ctx;
  const subjectTex = subjectTexture(ctx, subject.canvas);
  const resampled = createTarget(ctx, columns, length, 'linear');

  // 1. The subject, as seen along each streak.
  bindTarget(ctx, resampled, columns, length);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, subjectTex);
  if (geometry.kind === 'mesh') {
    const p = program(ctx, 'melt-resample-mesh', RESAMPLE_MESH_VERTEX, RESAMPLE_MESH_FRAGMENT);
    gl.useProgram(p.program);
    gl.uniform1i(uniform(ctx, p, 'u_subject'), 0);
    gl.uniform2f(uniform(ctx, p, 'u_local'), columns, length);
    gl.uniform2f(uniform(ctx, p, 'u_subjectOrigin'), subject.x, subject.y);
    gl.uniform2f(uniform(ctx, p, 'u_subjectSize'), subject.width, subject.height);
    const { vertices, indices } = meshGeometry(geometry.mesh);
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
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
    gl.disableVertexAttribArray(position);
    gl.disableVertexAttribArray(texcoord);
    gl.deleteBuffer(vertexBuffer);
    gl.deleteBuffer(indexBuffer);
  } else {
    const { arc } = geometry;
    const p = program(ctx, 'melt-resample-arc', FULLSCREEN_VERTEX, RESAMPLE_ARC_FRAGMENT);
    gl.useProgram(p.program);
    const set = (name: string) => uniform(ctx, p, name);
    gl.uniform1i(set('u_subject'), 0);
    gl.uniform2f(set('u_subjectOrigin'), subject.x, subject.y);
    gl.uniform2f(set('u_subjectSize'), subject.width, subject.height);
    gl.uniform2f(set('u_local'), columns, length);
    gl.uniform2f(set('u_centre'), arc.origin.x - Math.cos(arc.angle) * arc.radius, arc.origin.y - Math.sin(arc.angle) * arc.radius);
    gl.uniform1f(set('u_angle'), arc.angle);
    gl.uniform1f(set('u_sweep'), arc.sweep);
    gl.uniform1f(set('u_radius'), arc.radius);
    gl.uniform1f(set('u_width'), geometry.width);
    gl.uniform1i(set('u_outward'), arc.outward ? 1 : 0);
    drawFullscreen(ctx, p);
  }

  // 2. Smear and erase textures, band-local.
  const params = new Float32Array(columns * 4);
  for (let x = 0; x < columns; x++) {
    params[x * 4] = input.wander[x];
    params[x * 4 + 1] = input.side[x];
    params[x * 4 + 2] = input.rate[x];
  }
  const paramTexture = textureFromFloats(ctx, params, columns, 1);
  const smear = createTarget(ctx, columns, length, 'linear');
  const erase = createTarget(ctx, columns, length, 'linear');
  const p = program(ctx, 'melt-smear', FULLSCREEN_VERTEX, SMEAR_FRAGMENT);
  const smearPass = (target: Target, eraseOnly: boolean) => {
    bindTarget(ctx, target, columns, length);
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resampled.texture);
    gl.uniform1i(uniform(ctx, p, 'u_resampled'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, paramTexture);
    gl.uniform1i(uniform(ctx, p, 'u_params'), 1);
    gl.uniform1f(uniform(ctx, p, 'u_length'), length);
    gl.uniform1f(uniform(ctx, p, 'u_ramp'), Math.max(1e-6, input.ramp));
    gl.uniform1i(uniform(ctx, p, 'u_eraseOnly'), eraseOnly ? 1 : 0);
    drawFullscreen(ctx, p);
    gl.activeTexture(gl.TEXTURE0);
  };
  smearPass(smear, false);
  smearPass(erase, true);

  // 3. Into the document: smear and erase stacked on the GL canvas, then copied
  // out together, so the GPU flushes once rather than once per texture.
  const reserve = bounds.height * 2;
  const place = (target: Target, slot: CanvasSlot) => (geometry.kind === 'mesh'
    ? drawTextureOnMesh(ctx, target.texture, geometry.mesh, bounds, false, geometry.curved, slot)
    : drawArcOnGL(ctx, {
      arc: geometry.arc,
      width: geometry.width,
      columns,
      texture: target.texture,
      textureLength: length,
      mode: 'local',
      inner: geometry.inner,
      outer: geometry.outer,
      fade: 0,
      soft: 0,
      grid: { strength: 0, size: 8, style: 'cut' },
      bounds,
    }, slot));
  place(smear, { top: 0, reserve });
  place(erase, { top: bounds.height, reserve });
  const result = {
    smear: copyToCanvas(ctx, bounds.width, bounds.height, 0),
    erase: copyToCanvas(ctx, bounds.width, bounds.height, bounds.height),
  };

  gl.deleteTexture(paramTexture);
  deleteTarget(ctx, resampled);
  deleteTarget(ctx, smear);
  deleteTarget(ctx, erase);
  return result;
}
