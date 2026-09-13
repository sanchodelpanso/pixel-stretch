import { test, expect } from '@playwright/test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

const photo = path.resolve('piza.HEIC');
async function openPhoto(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('input[accept^="image/"]').setInputFiles(photo);
  await expect(page.getByRole('button', { name: 'Auto', exact: true })).toBeVisible();
}
async function waitSelection(page: import('@playwright/test').Page) {
  await expect(page.locator('.editor-busy')).toHaveCount(0);
  await expect(page.locator('.editor-hint.error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy to new layer' })).toBeVisible();
}

test('opening a photo does not download models; HEIC preserves full resolution', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('huggingface.co')) requests.push(request.url()); });
  await openPhoto(page);
  await expect(page.locator('.layer-dims')).toHaveText('4284 × 5712');
  expect(requests).toEqual([]);
});

test('Auto selects Pisa architecture, exports transparent PNG, and supports undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openPhoto(page);
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await waitSelection(page);
  await page.getByRole('button', { name: 'Copy to new layer' }).click();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await page.locator('.layer-row').filter({ has: page.locator('.layer-name', { hasText: /^Background$/ }) }).getByTitle('Hide layer').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG' }).click();
  const download = await downloadPromise;
  await mkdir('artifacts/segmentation', { recursive: true });
  await download.saveAs('artifacts/segmentation/pisa-browser-cutout.png');
  // Inspect the exported PNG, including full size and representative subject/background pixels.
  const result = await page.evaluate(async (url) => {
    const image = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const alpha = (x: number, y: number) => context.getImageData(Math.floor(x * image.width), Math.floor(y * image.height), 1, 1).data[3];
    return { width: image.width, height: image.height, tower: alpha(.34,.4), cathedral: alpha(.63,.6), sky: alpha(.7,.2), lawn: alpha(.5,.9), tree: alpha(.07,.4) };
  }, '/artifacts/segmentation/pisa-browser-cutout.png');
  expect(result.width).toBe(4284);
  expect(result.height).toBe(5712);
  expect(result.tower).toBeGreaterThan(240);
  expect(result.cathedral).toBeGreaterThan(240);
  expect(result.sky).toBeLessThan(10);
  expect(result.lawn).toBeLessThan(10);
  expect(result.tree).toBeLessThan(10);
  await page.screenshot({ path: 'artifacts/segmentation/pisa-editor.png' });
  expect(errors).toEqual([]);
});

test('Tap and a single Brush stroke both produce a selection', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('button', { name: 'Tap', exact: true }).click();
  await expect(page.locator('.editor-canvas-wrapper')).toHaveAttribute('data-selection-ready', 'true');
  await expect(page.locator('.editor-busy')).toHaveCount(0);
  await expect(page.locator('.editor-hint.error')).toHaveCount(0);
  const canvas = page.locator('.editor-canvas-wrapper');
  const bounds = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: bounds.width * .34, y: bounds.height * .4 } });
  await waitSelection(page);
  await page.getByRole('button', { name: 'Brush', exact: true }).click();
  await expect(page.locator('.editor-canvas-wrapper')).toHaveAttribute('data-selection-ready', 'true');
  await expect(page.locator('.brush-canvas')).toBeVisible();
  await expect(page.locator('.editor-busy')).toHaveCount(0);
  const brush = page.locator('.brush-canvas');
  const dimensions = await brush.evaluate((element: HTMLCanvasElement) => ({ width: element.width, height: element.height }));
  expect(dimensions.height).toBeGreaterThan(300);
  await page.mouse.move(bounds.x + bounds.width * .34, bounds.y + bounds.height * .2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .36, bounds.y + bounds.height * .7, { steps: 12 });
  await page.mouse.up();
  await waitSelection(page);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('.selection-section')).toHaveCount(0);
});

test('switching away during inference cannot restore a stale selection', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.locator('.editor-busy')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tap', exact: true }).click();
  await expect(page.locator('.editor-canvas-wrapper')).toHaveAttribute('data-selection-ready', 'true');
  await expect(page.locator('.editor-busy')).toHaveCount(0);
  await expect(page.locator('.editor-hint.error')).toHaveCount(0);
  await expect(page.locator('.selection-section')).toHaveCount(0);
});

test('project save and reopen preserves layers and stretch geometry', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('button', { name: 'Stretch', exact: true }).click();
  const canvas = page.locator('.editor-canvas-wrapper');
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .25, bounds.y + bounds.height * .42);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .7, bounds.y + bounds.height * .42, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.path-lock')).toBeVisible();
  await page.locator('.path-lock').dispatchEvent('pointerdown', { pointerId: 1 });
  await expect(page.locator('.stretch-preview')).toBeVisible();
  await page.mouse.move(bounds.x + bounds.width * .48, bounds.y + bounds.height * .42);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .48, bounds.y + bounds.height * .72, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.layer-kind', { hasText: 'stretch' })).toBeVisible();
  await expect(page.locator('.layer-kind', { hasText: 'subject' })).toBeVisible();
  await expect(page.locator('.layer-row')).toHaveCount(3);
  expect(await page.locator('.layer-name').allTextContents()).toEqual([
    'Background subject',
    'Background stretch',
    'Background',
  ]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(3);

  const widthBeforeCornerDrag = Number(await page.getByLabel('Width').inputValue());
  // Pull the top-right corner inward: it bends the sheet without resizing it,
  // and every edge's handles appear so the bend can be reshaped.
  const corner = page.locator('.rect-handle').nth(2);
  const cornerBox = (await corner.boundingBox())!;
  await page.mouse.move(cornerBox.x + cornerBox.width / 2, cornerBox.y + cornerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cornerBox.x - 70, cornerBox.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByLabel('Wrap')).toHaveValue('0');
  await expect(page.getByLabel('Width')).toHaveValue(String(widthBeforeCornerDrag));
  await expect(page.locator('.rect-outline.warped')).toBeVisible();
  await expect(page.locator('.edge-control')).toHaveCount(8);
  await expect(page.locator('.rect-grid path')).toHaveCount(4);
  await mkdir('artifacts/segmentation', { recursive: true });
  await page.screenshot({ path: 'artifacts/segmentation/pisa-corner-bend.png' });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Wrap')).toHaveValue('0');
  await expect(page.locator('.edge-control')).toHaveCount(0);
  await expect(page.locator('.rect-grid path')).toHaveCount(4);

  await page.getByRole('button', { name: 'Arc right', exact: true }).click();
  await expect(page.locator('.edge-control')).toHaveCount(8);
  const depthHandle = page.locator('.bend-depth.active');
  await expect(depthHandle).toBeVisible();
  const depthBefore = Number(await page.getByLabel('Wrap').inputValue());
  const depthBox = (await depthHandle.boundingBox())!;
  await page.mouse.move(depthBox.x + depthBox.width / 2, depthBox.y + depthBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(depthBox.x + depthBox.width / 2, depthBox.y + depthBox.height / 2 + 12, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Number(await page.getByLabel('Wrap').inputValue())).toBeGreaterThan(depthBefore);
  await mkdir('artifacts/segmentation', { recursive: true });
  await page.screenshot({ path: 'artifacts/segmentation/pisa-protected-stretch.png' });
  await page.locator('.layer-row').filter({ has: page.locator('.layer-name', { hasText: /^Background$/ }) }).getByTitle('Hide layer').click();
  await page.screenshot({ path: 'artifacts/segmentation/pisa-3d-bend.png' });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save Project' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pixelstretch$/);
  const savedPath = path.resolve('artifacts/segmentation/roundtrip.pixelstretch');
  await download.saveAs(savedPath);
  const manifest = JSON.parse(await readFile(savedPath, 'utf8'));
  expect(manifest.format).toBe('com.pixelstretch.project');
  expect(manifest.version).toBe(1);
  expect(manifest.canvas).toEqual({ width: 4284, height: 5712 });
  expect(manifest.layers).toHaveLength(3);
  const stretchLayer = manifest.layers.find((layer: { stretch?: unknown }) => layer.stretch);
  const subjectLayer = manifest.layers.find((layer: { protectionSourceId?: string }) => layer.protectionSourceId);
  expect(stretchLayer).toBeTruthy();
  expect(stretchLayer.stretch.points).toHaveLength(2);
  expect(stretchLayer.stretch.bend).toBeGreaterThan(0);
  expect(stretchLayer.stretch.warpMode).toBe('curved');
  expect(stretchLayer.stretch.edges).toHaveLength(4);
  expect(stretchLayer.stretch.fade).toBe(0);
  expect(stretchLayer.stretch.edgeSoftness).toBe(0);
  expect(stretchLayer.bitmap.data.length).toBeGreaterThan(100);
  expect(subjectLayer.protectionSourceId).toBe(manifest.layers[0].id);

  await page.reload();
  await page.locator('input[accept*=".pixelstretch"]').setInputFiles(savedPath);
  await expect(page.locator('.layer-row')).toHaveCount(3);
  await expect(page.locator('.layer-kind', { hasText: 'stretch' })).toBeVisible();
  await expect(page.locator('.layer-kind', { hasText: 'subject' })).toBeVisible();
  await expect(page.locator('.layer-row.selected .layer-name')).toHaveText(manifest.layers.find(
    (layer: { id: string }) => layer.id === manifest.selectedLayerId,
  ).name);
});

test('invalid project files show a useful error', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[accept*=".pixelstretch"]').setInputFiles({
    name: 'damaged.pixelstretch',
    mimeType: 'application/vnd.pixelstretch.project+json',
    buffer: Buffer.from('{"format":"wrong"}'),
  });
  await expect(page.locator('.upload-error')).toHaveText('This file is not a PixelStretch project.');
});

test('mobile editor uses a touch toolbar and layers sheet without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPhoto(page);

  const toolbar = page.locator('.toolbar');
  const toolButtons = toolbar.locator('.tool-btn');
  await expect(toolButtons).toHaveCount(6);
  for (const button of await toolButtons.all()) {
    const box = await button.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  const viewportMetrics = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewportMetrics.scrollWidth).toBeLessThanOrEqual(viewportMetrics.innerWidth);

  const panel = page.getByLabel('Layers and properties');
  await expect(panel).not.toBeVisible();
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move Background up' })).toBeVisible();

  await expect.poll(async () => {
    const panelBox = (await panel.boundingBox())!;
    const toolbarBox = (await toolbar.boundingBox())!;
    return panelBox.y + panelBox.height - toolbarBox.y;
  }).toBeLessThanOrEqual(1);

  await mkdir('artifacts/mobile', { recursive: true });
  await page.screenshot({ path: 'artifacts/mobile/editor.png' });

  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(panel).not.toBeVisible();
});

test('mobile upload screen fits the viewport and keeps its primary target touch-sized', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const dropzone = page.getByRole('button', { name: /Drop an image or project/ });
  await expect(dropzone).toBeVisible();
  const box = (await dropzone.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(350);
  expect(box.height).toBeGreaterThanOrEqual(160);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await mkdir('artifacts/mobile', { recursive: true });
  await page.screenshot({ path: 'artifacts/mobile/upload.png' });
});
