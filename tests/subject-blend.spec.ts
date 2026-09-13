import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('lifted subjects feather inward without changing their source or growing a halo', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createCanvas, layerFromCanvas, extractLayer } = await import('/src/layers/layer-utils.ts');
    const { subjectBlendCanvas } = await import('/src/layers/subject-blend.ts');
    const canvas = createCanvas(48, 48);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 48, 48);
    const source = layerFromCanvas(canvas, 'Photo');
    const mask = new Float32Array(48 * 48);
    for (let y = 8; y < 40; y++) {
      for (let x = 8; x < 40; x++) {
        // Include an internal gap, like the space between an arm and torso.
        if (x < 20 || x >= 28 || y < 20 || y >= 28) mask[y * 48 + x] = 1;
      }
    }
    const subject = extractLayer(source, mask, 48, 48, 'Subject')!;
    subject.protectionSourceId = source.id;
    const doc = { width: 48, height: 48, layers: [source, subject] };
    const pixels = (image: HTMLCanvasElement) => image.getContext('2d')!
      .getImageData(0, 0, image.width, image.height).data;
    const originalSource = pixels(source.canvas);
    const originalSubject = pixels(subject.canvas);
    const blended = subjectBlendCanvas(subject, doc);
    const output = pixels(blended);
    const alpha = (x: number, y: number) => output[(y * subject.width + x) * 4 + 3];
    const unprotected = { ...subject, protectionSourceId: undefined };
    const sourceAfter = pixels(source.canvas);
    const subjectAfter = pixels(subject.canvas);
    let expandedPixels = 0;
    let changedColors = 0;
    for (let i = 0; i < output.length; i += 4) {
      if (output[i + 3] > originalSubject[i + 3]) expandedPixels++;
      if (output[i + 3] && (output[i] !== 255 || output[i + 1] !== 0 || output[i + 2] !== 0)) {
        changedColors++;
      }
    }
    return {
      bounds: [subject.x, subject.y, subject.width, subject.height],
      sourceUnchanged: originalSource.every((value, index) => sourceAfter[index] === value),
      subjectUnchanged: originalSubject.every((value, index) => subjectAfter[index] === value),
      unprotectedIsOriginal: subjectBlendCanvas(unprotected, doc) === subject.canvas,
      originalEdge: originalSubject[(10 * subject.width) * 4 + 3],
      trimmedEdge: alpha(0, 10),
      interior: alpha(6, 6),
      holeEdge: alpha(11, 15),
      hole: alpha(15, 15),
      expandedPixels,
      changedColors,
    };
  });

  expect(result.bounds).toEqual([8, 8, 32, 32]);
  expect(result.sourceUnchanged).toBe(true);
  expect(result.subjectUnchanged).toBe(true);
  expect(result.unprotectedIsOriginal).toBe(true);
  expect(result.originalEdge).toBe(255);
  expect(result.trimmedEdge).toBeGreaterThan(0);
  expect(result.trimmedEdge).toBeLessThan(255);
  expect(result.interior).toBe(255);
  expect(result.holeEdge).toBeGreaterThan(0);
  expect(result.holeEdge).toBeLessThan(255);
  expect(result.hole).toBe(0);
  expect(result.expandedPixels).toBe(0);
  expect(result.changedColors).toBe(0);
});

test('photo boundaries stay opaque and cached blending follows bitmap and placement changes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createCanvas, layerFromCanvas, extractLayer } = await import('/src/layers/layer-utils.ts');
    const { subjectBlendCanvas } = await import('/src/layers/subject-blend.ts');
    const canvas = createCanvas(32, 24);
    canvas.getContext('2d')!.fillRect(0, 0, 32, 24);
    // The photo is offset inside the document: its own bounds govern clipping.
    const source = layerFromCanvas(canvas, 'Photo', 13, 9);
    const fullSubject = { ...layerFromCanvas(canvas, 'Full subject', 13, 9), protectionSourceId: source.id };
    const doc = { width: 96, height: 72, layers: [source, fullSubject] };
    const pixel = (image: HTMLCanvasElement, x: number, y: number) =>
      Array.from(image.getContext('2d')!.getImageData(x, y, 1, 1).data);
    const fullBlend = subjectBlendCanvas(fullSubject, doc);
    const fullPixels = fullBlend.getContext('2d')!.getImageData(0, 0, 32, 24).data;

    const mask = new Float32Array(32 * 24);
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 16; x++) mask[y * 32 + x] = 1;
    }
    const trimmedSubject = extractLayer(source, mask, 32, 24, 'Cropped subject')!;
    trimmedSubject.protectionSourceId = source.id;
    const trimmedBlend = subjectBlendCanvas(trimmedSubject, doc);
    const cacheReused = subjectBlendCanvas(trimmedSubject, doc) === trimmedBlend;

    const movedSubject = { ...trimmedSubject, x: trimmedSubject.x + 4 };
    const movedBlend = subjectBlendCanvas(movedSubject, doc);
    const replacement = createCanvas(16, 24);
    replacement.getContext('2d')!.fillStyle = '#00ff00';
    replacement.getContext('2d')!.fillRect(0, 0, 16, 24);
    const replacedSubject = { ...trimmedSubject, canvas: replacement };
    const replacedBlend = subjectBlendCanvas(replacedSubject, doc);
    return {
      fullPhotoOpaque: fullPixels.every((value, index) => index % 4 !== 3 || value === 255),
      photoEdge: pixel(trimmedBlend, 0, 12)[3],
      trimmedEdge: pixel(trimmedBlend, 15, 12)[3],
      cacheReused,
      movedRecomputed: movedBlend !== trimmedBlend,
      movedEdge: pixel(movedBlend, 0, 12)[3],
      replacementRecomputed: replacedBlend !== trimmedBlend,
      replacementPixel: pixel(replacedBlend, 6, 12),
    };
  });

  expect(result.fullPhotoOpaque).toBe(true);
  expect(result.photoEdge).toBe(255);
  expect(result.trimmedEdge).toBeGreaterThan(0);
  expect(result.trimmedEdge).toBeLessThan(255);
  expect(result.cacheReused).toBe(true);
  expect(result.movedRecomputed).toBe(true);
  expect(result.movedEdge).toBeLessThan(255);
  expect(result.replacementRecomputed).toBe(true);
  expect(result.replacementPixel).toEqual([0, 255, 0, 255]);
});

test('preview and PNG export use the same subject blend and layer visibility', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createCanvas, layerFromCanvas } = await import('/src/layers/layer-utils.ts');
    const { drawDocumentLayers, exportDocument } = await import('/src/layers/compositor.ts');
    const solid = (width: number, height: number, color: string) => {
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d')!;
      context.fillStyle = color;
      context.fillRect(0, 0, width, height);
      return canvas;
    };
    const source = layerFromCanvas(solid(48, 48, '#0000ff'), 'Photo');
    const subject = { ...layerFromCanvas(solid(24, 24, '#ff0000'), 'Subject', 12, 12), protectionSourceId: source.id };
    const hidden = { ...layerFromCanvas(solid(48, 48, '#00ff00'), 'Hidden'), visible: false };
    const transparent = { ...hidden, visible: true, opacity: 0 };
    const doc = { width: 48, height: 48, layers: [source, subject, hidden, transparent] };
    const preview = createCanvas(48, 48);
    drawDocumentLayers(preview.getContext('2d')!, doc);
    const image = await createImageBitmap(await exportDocument(doc));
    const exported = createCanvas(image.width, image.height);
    exported.getContext('2d')!.drawImage(image, 0, 0);
    image.close();
    const previewPixels = preview.getContext('2d')!.getImageData(0, 0, 48, 48).data;
    const exportPixels = exported.getContext('2d')!.getImageData(0, 0, 48, 48).data;
    const pixel = (x: number, y: number) => Array.from(previewPixels.slice((y * 48 + x) * 4, (y * 48 + x) * 4 + 4));
    return {
      dimensions: [exported.width, exported.height],
      mismatchedChannels: previewPixels.reduce((count, value, index) => count + Number(value !== exportPixels[index]), 0),
      background: pixel(5, 5),
      edge: pixel(12, 24),
      interior: pixel(24, 24),
    };
  });

  expect(result.dimensions).toEqual([48, 48]);
  expect(result.mismatchedChannels).toBe(0);
  expect(result.background).toEqual([0, 0, 255, 255]);
  expect(result.interior).toEqual([255, 0, 0, 255]);
  expect(result.edge[0]).toBeGreaterThan(0);
  expect(result.edge[0]).toBeLessThan(255);
  expect(result.edge[1]).toBe(0);
  expect(result.edge[2]).toBeGreaterThan(0);
  expect(result.edge[3]).toBe(255);
});

test('project save and reopen preserve original subject pixels without accumulating feathering', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createCanvas, layerFromCanvas } = await import('/src/layers/layer-utils.ts');
    const { flattenDocument } = await import('/src/layers/compositor.ts');
    const { encodeProject, decodeProject } = await import('/src/project/project-file.ts');
    const source = layerFromCanvas(createCanvas(32, 32), 'Photo');
    source.visible = false;
    const canvas = createCanvas(16, 16);
    canvas.getContext('2d')!.fillStyle = '#ff0000';
    canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
    const subject = { ...layerFromCanvas(canvas, 'Subject', 8, 8), protectionSourceId: source.id };
    const doc = { width: 32, height: 32, layers: [source, subject] };
    const pixels = (image: HTMLCanvasElement) => image.getContext('2d')!
      .getImageData(0, 0, image.width, image.height).data;
    const originalPixels = pixels(flattenDocument(doc));
    const first = await decodeProject(await encodeProject(doc, subject.id));
    const firstPixels = pixels(flattenDocument(first.document));
    const second = await decodeProject(await encodeProject(first.document, first.selectedLayerId));
    const secondPixels = pixels(flattenDocument(second.document));
    const savedSubject = second.document.layers.find((layer: { id: string }) => layer.id === subject.id)!;
    const rawPixels = pixels(savedSubject.canvas);
    return {
      firstMismatchCount: originalPixels.reduce((count, value, index) => count + Number(value !== firstPixels[index]), 0),
      secondMismatchCount: originalPixels.reduce((count, value, index) => count + Number(value !== secondPixels[index]), 0),
      storedAlphaIsOriginal: rawPixels.every((value, index) => index % 4 !== 3 || value === 255),
      renderedEdgeAlpha: secondPixels[(16 * 32 + 8) * 4 + 3],
      selectedLayerId: second.selectedLayerId,
      protectionSourceId: savedSubject.protectionSourceId,
      subjectId: subject.id,
      sourceId: source.id,
    };
  });

  expect(result.firstMismatchCount).toBe(0);
  expect(result.secondMismatchCount).toBe(0);
  expect(result.storedAlphaIsOriginal).toBe(true);
  expect(result.renderedEdgeAlpha).toBeGreaterThan(0);
  expect(result.renderedEdgeAlpha).toBeLessThan(255);
  expect(result.selectedLayerId).toBe(result.subjectId);
  expect(result.protectionSourceId).toBe(result.sourceId);
});
