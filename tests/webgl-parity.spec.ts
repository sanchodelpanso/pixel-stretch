import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

/**
 * The GPU band renderer must draw what the CPU renderer draws. Each case renders
 * once with WebGL off and once with it on, and compares premultiplied pixels.
 */
test('the WebGL band renderer matches the canvas renderer', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { renderStretchBand } = await import('/src/rendering/stretch-band.ts');
    const { renderSubjectMelt } = await import('/src/rendering/edge-blend.ts');
    const { setGpuRendering, getGL } = await import('/src/rendering/gl/gl-context.ts');
    const { layerFromCanvas, createCanvas } = await import('/src/layers/layer-utils.ts');
    const { skewCorner, pullCorner } = await import('/src/types/stretch.ts');

    // A textured photo and an elliptical lifted subject.
    const photo = createCanvas(900, 1000);
    const p = photo.getContext('2d')!;
    for (let y = 0; y < 1000; y += 20) {
      for (let x = 0; x < 900; x += 20) {
        p.fillStyle = `hsl(${(x * 0.4 + y * 0.2) % 360},55%,${35 + ((x + y) % 60) / 2}%)`;
        p.fillRect(x, y, 20, 20);
      }
    }
    const source = layerFromCanvas(photo, 'Photo');
    const cut = createCanvas(360, 440);
    const c = cut.getContext('2d')!;
    for (let y = 0; y < 440; y += 12) {
      c.fillStyle = `hsl(${y},60%,45%)`;
      c.fillRect(0, y, 360, 12);
    }
    c.globalCompositeOperation = 'destination-in';
    c.beginPath();
    c.ellipse(180, 220, 175, 215, 0, 0, Math.PI * 2);
    c.fill();
    const subject = { ...layerFromCanvas(cut, 'Subject', 300, 320), protectionSourceId: source.id };

    const base = {
      points: [{ x: 450, y: 350 }, { x: 450, y: 700 }], sourceLayerId: source.id, anchor: { x: 450, y: 350 },
      width: 350, length: 380, rotation: 0, fade: 0, edgeSoftness: 0, bend: 0,
    };
    const skewed = { ...base, ...skewCorner(base, 2, { x: 880, y: 760 }) };
    const folded = { ...base, ...pullCorner(base, 1, { x: 280, y: 620 }) };
    const arc = { origin: { x: 450, y: 525 }, angle: Math.PI, radius: 380, sweep: Math.PI / 2, outward: true };

    type Render = { canvas: HTMLCanvasElement; x: number; y: number } | null;
    const cases: [string, () => Render][] = [
      ['skewed', () => renderStretchBand(skewed, source, subject)],
      ['skewed with fade and grid', () => renderStretchBand({ ...skewed, fade: 0.6, edgeSoftness: 0.1, gridTexture: 0.7 }, source, subject)],
      ['curved fold', () => renderStretchBand(folded, source, subject)],
      ['pixel soft edges', () => renderStretchBand({ ...base, style: 'pixel', pixelSoftness: 0.6, pixelSize: 12 }, source, subject)],
      ['arc', () => renderStretchBand({ ...base, arc }, source, subject)],
      ['arc with fade and grid only', () => renderStretchBand({ ...base, arc, fade: 0.5, edgeSoftness: 0.2, gridTexture: 1, gridStyle: 'lines' }, source, subject)],
      ['arc pixel', () => renderStretchBand({ ...base, arc, style: 'pixel' }, source, subject)],
      ['arc motion', () => renderStretchBand({ ...base, arc, style: 'motion' }, source, subject)],
      ['melt smear', () => renderSubjectMelt({ ...base, edgeBlend: 0.4 }, subject)?.smear ?? null],
      ['skewed melt erase', () => renderSubjectMelt({ ...skewed, edgeBlend: 0.5 }, subject)?.erase ?? null],
      ['arc melt smear', () => renderSubjectMelt({ ...base, arc, edgeBlend: 0.4 }, subject)?.smear ?? null],
    ];

    const pixels = (canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const compare = (cpu: Render, gpu: Render) => {
      if (!cpu || !gpu) return { sameBounds: false, meanDiff: Infinity, painted: 0 };
      const sameBounds = cpu.x === gpu.x && cpu.y === gpu.y
        && cpu.canvas.width === gpu.canvas.width && cpu.canvas.height === gpu.canvas.height;
      if (!sameBounds) return { sameBounds, meanDiff: Infinity, painted: 0 };
      const a = pixels(cpu.canvas);
      const b = pixels(gpu.canvas);
      let total = 0;
      let painted = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i + 3] === 0 && b[i + 3] === 0) continue;
        let worst = Math.abs(a[i + 3] - b[i + 3]);
        for (let channel = 0; channel < 3; channel++) {
          worst = Math.max(worst, Math.abs((a[i + channel] * a[i + 3]) / 255 - (b[i + channel] * b[i + 3]) / 255));
        }
        total += worst;
        painted++;
      }
      return { sameBounds, meanDiff: total / Math.max(1, painted), painted };
    };

    const hasGpu = Boolean(getGL());
    const out = cases.map(([name, render]) => {
      setGpuRendering(false);
      const cpu = render();
      setGpuRendering(true);
      const gpu = render();
      return { name, ...compare(cpu, gpu) };
    });
    return { hasGpu, out };
  });

  test.skip(!results.hasGpu, 'WebGL2 is not available in this browser');
  for (const result of results.out) {
    expect.soft(result.sameBounds, `${result.name}: same bounds`).toBe(true);
    expect.soft(result.painted, `${result.name}: draws something`).toBeGreaterThan(0);
    // On a 0–255 scale; filtering differs slightly between the two, never visibly.
    expect.soft(result.meanDiff, `${result.name}: mean pixel difference`).toBeLessThan(4);
  }
});
