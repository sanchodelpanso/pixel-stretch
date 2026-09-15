import {
  bindTarget, copyToCanvas, createTarget, deleteTarget, drawFullscreen, fits, FULLSCREEN_VERTEX, program,
  textureFromCanvas, uniform, type GL, type Target,
} from './gl-context';

/** Largest blur radius the shader loops over. */
export const MAX_GL_BLUR_RADIUS = 32;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform ivec2 u_step;
uniform int u_radius;
uniform bool u_flipOutput;
uniform float u_height;
out vec4 color;
void main() {
  ivec2 size = textureSize(u_source, 0);
  ivec2 at = ivec2(gl_FragCoord.xy);
  // The final pass draws to the canvas, whose rows run the other way.
  if (u_flipOutput) at.y = int(u_height) - 1 - at.y;
  vec4 sum = vec4(0.0);
  for (int i = -${MAX_GL_BLUR_RADIUS}; i <= ${MAX_GL_BLUR_RADIUS}; i++) {
    if (i < -u_radius || i > u_radius) continue;
    ivec2 p = at + u_step * i;
    // Outside the image counts as transparent, so the band's own edges soften too.
    if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) continue;
    sum += texelFetch(u_source, p, 0);
  }
  color = sum / float(2 * u_radius + 1);
}
`;

/**
 * Feather a canvas on the GPU: two passes of a separable box blur of `radius`,
 * premultiplied — the same result as `softenPixels`. Returns a new canvas, or
 * null when it can't run here.
 */
export function softenOnGL(ctx: GL, source: HTMLCanvasElement, radius: number): HTMLCanvasElement | null {
  const r = Math.min(MAX_GL_BLUR_RADIUS, Math.max(0, Math.round(radius)));
  const { width, height } = source;
  if (r < 1 || !fits(ctx, width, height)) return null;
  const { gl } = ctx;
  const p = program(ctx, 'box-blur', FULLSCREEN_VERTEX, FRAGMENT);
  const input = textureFromCanvas(ctx, source, 'nearest');
  const a = createTarget(ctx, width, height, 'nearest');
  const b = createTarget(ctx, width, height, 'nearest');

  const pass = (from: WebGLTexture, to: Target | null, step: [number, number]) => {
    const flipHeight = bindTarget(ctx, to, width, height);
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from);
    gl.uniform1i(uniform(ctx, p, 'u_source'), 0);
    gl.uniform2i(uniform(ctx, p, 'u_step'), step[0], step[1]);
    gl.uniform1i(uniform(ctx, p, 'u_radius'), r);
    gl.uniform1i(uniform(ctx, p, 'u_flipOutput'), to ? 0 : 1);
    gl.uniform1f(uniform(ctx, p, 'u_height'), flipHeight);
    drawFullscreen(ctx, p);
  };
  pass(input, a, [1, 0]);
  pass(a.texture, b, [0, 1]);
  pass(b.texture, a, [1, 0]);
  pass(a.texture, null, [0, 1]);

  gl.deleteTexture(input);
  deleteTarget(ctx, a);
  deleteTarget(ctx, b);
  return copyToCanvas(ctx, width, height);
}
