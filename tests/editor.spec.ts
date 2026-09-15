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

async function openSyntheticStretch(page: import('@playwright/test').Page) {
  const project = JSON.parse(await readFile(path.resolve('PixelStretch.pixelstretch'), 'utf8'));
  const source = project.layers[0];
  const stretchId = 'browser-test-stretch';
  project.selectedLayerId = stretchId;
  project.layers.push({
    id: stretchId,
    name: '2D shape test',
    width: 400,
    height: 400,
    x: 150,
    y: 300,
    visible: true,
    opacity: 1,
    locked: false,
    bitmap: source.bitmap,
    stretch: {
      points: [{ x: 150, y: 300 }, { x: 550, y: 300 }],
      sourceLayerId: source.id,
      anchor: { x: 150, y: 300 },
      width: 400,
      length: -400,
      rotation: 0,
      fade: 0,
      edgeSoftness: 0,
      bend: 0,
    },
  });

  await page.goto('/');
  await page.locator('input[accept*=".pixelstretch"]').setInputFiles({
    name: 'shape-test.pixelstretch',
    mimeType: 'application/vnd.pixelstretch.project+json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.getByRole('button', { name: 'Stretch', exact: true }).click();
  await expect(page.locator('.stretch-rect-handles')).toBeVisible();
}

test('opening a photo does not download models; HEIC preserves full resolution', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('huggingface.co')) requests.push(request.url()); });
  await openPhoto(page);
  await expect(page.locator('.layer-dims')).toHaveText('4284 × 5712');
  expect(requests).toEqual([]);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.position-row .property-value')).toHaveText('0, 0');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
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

test('Tap selects an object and deselect returns to Stretch', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('button', { name: 'Tap', exact: true }).click();
  await expect(page.locator('.editor-canvas-wrapper')).toHaveAttribute('data-selection-ready', 'true');
  await expect(page.locator('.editor-busy')).toHaveCount(0);
  await expect(page.locator('.editor-hint.error')).toHaveCount(0);
  const canvas = page.locator('.editor-canvas-wrapper');
  const bounds = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: bounds.width * .34, y: bounds.height * .4 } });
  await waitSelection(page);
  await page.getByRole('button', { name: 'Deselect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stretch', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.selection-section')).toHaveCount(0);
});

test('switching away during inference cannot restore a stale selection', async ({ page }) => {
  await openPhoto(page);
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await page.getByRole('button', { name: 'Stretch', exact: true }).click();
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
  await expect(page.getByLabel('Wrap')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Arc right', exact: true })).toHaveCount(0);

  // Straight mode keeps a corner drag as an ordinary 2D skew. It does not
  // resize the source rectangle or expose the curved-surface controls.
  const corner = page.locator('.rect-handle').nth(2);
  const cornerBox = (await corner.boundingBox())!;
  await page.mouse.move(cornerBox.x + cornerBox.width / 2, cornerBox.y + cornerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cornerBox.x - 70, cornerBox.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByLabel('Width')).toHaveValue(String(widthBeforeCornerDrag));
  await expect(page.locator('.rect-outline.warped')).toBeVisible();
  await expect(page.locator('.edge-control')).toHaveCount(0);
  await expect(page.locator('.rect-grid path')).toHaveCount(4);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.edge-control')).toHaveCount(0);
  await expect(page.locator('.rect-grid path')).toHaveCount(4);

  // Curved mode starts flat and exposes the 2D Bézier controls. Pulling a
  // corner in this mode retains the existing localized paper-fold gesture.
  await page.locator('.rect-mode').filter({ hasText: /^(Straight 2D skew|Curved shape)/ }).dispatchEvent('pointerdown', { pointerId: 2 });
  await expect(page.locator('.edge-control')).toHaveCount(8);
  const curvedCorner = page.locator('.rect-handle').nth(2);
  const curvedCornerBox = (await curvedCorner.boundingBox())!;
  await page.mouse.move(curvedCornerBox.x + curvedCornerBox.width / 2, curvedCornerBox.y + curvedCornerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(curvedCornerBox.x - 70, curvedCornerBox.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.edge-control')).toHaveCount(8);
  await mkdir('artifacts/segmentation', { recursive: true });
  await page.screenshot({ path: 'artifacts/segmentation/pisa-corner-bend.png' });

  // The direct canvas grip still adds cylindrical 3D depth even though its
  // duplicate presets and side-panel slider have been removed.
  const depthHandle = page.locator('.bend-depth');
  await expect(depthHandle).toBeVisible();
  const depthBox = (await depthHandle.boundingBox())!;
  await page.mouse.move(depthBox.x + depthBox.width / 2, depthBox.y + depthBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(depthBox.x + depthBox.width / 2, depthBox.y + depthBox.height / 2 + 12, { steps: 5 });
  await page.mouse.up();
  await expect(depthHandle).toHaveClass(/active/);
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

test('straight corners skew in 2D and curved controls start as a flat wave surface', async ({ page }) => {
  await openSyntheticStretch(page);
  await expect(page.getByLabel('Wrap')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Arc right', exact: true })).toHaveCount(0);

  const corner = page.locator('.rect-handle').nth(2);
  const box = (await corner.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 45, box.y + 35, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.rect-outline.warped')).toBeVisible();
  await expect(page.locator('.edge-control')).toHaveCount(0);

  await page.locator('.rect-mode').filter({ hasText: /^(Straight 2D skew|Curved shape)/ }).dispatchEvent('pointerdown', { pointerId: 3 });
  await expect(page.locator('.edge-control')).toHaveCount(8);
  await expect(page.locator('.rect-mode').filter({ hasText: /^(Straight 2D skew|Curved shape)/ }).locator('title')).toHaveText('Curved shape — click for straight 2D skew');

  const control = page.locator('.edge-control').first();
  const controlBox = (await control.boundingBox())!;
  await page.mouse.move(controlBox.x + controlBox.width / 2, controlBox.y + controlBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(controlBox.x + 25, controlBox.y - 20, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByText(/round handles make a flat wave/i)).toBeVisible();
});

test('arc mode sweeps a locked line round into a ring with radius and width handles', async ({ page }) => {
  const project = JSON.parse(await readFile(path.resolve('PixelStretch.pixelstretch'), 'utf8'));
  // An existing subject layer lets the stretch commit without the subject model.
  project.layers[1].protectionSourceId = project.layers[0].id;
  project.selectedLayerId = project.layers[0].id;
  await page.goto('/');
  await page.locator('input[accept*=".pixelstretch"]').setInputFiles({
    name: 'arc-test.pixelstretch',
    mimeType: 'application/vnd.pixelstretch.project+json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.getByRole('button', { name: 'Stretch', exact: true }).click();

  const bounds = (await page.locator('.editor-canvas-wrapper').boundingBox())!;
  const mx = bounds.x + bounds.width * 0.5;
  await page.mouse.move(mx, bounds.y + bounds.height * 0.33);
  await page.mouse.down();
  await page.mouse.move(mx, bounds.y + bounds.height * 0.52, { steps: 8 });
  await page.mouse.up();
  await page.locator('.path-lock').dispatchEvent('pointerdown', { pointerId: 1 });
  await page.getByRole('group', { name: 'Band shape' }).getByRole('button', { name: 'Arc' }).click();

  // Pull right from the middle of the line and keep curling round to the start.
  const my = bounds.y + bounds.height * 0.425;
  const radius = bounds.width * 0.2;
  await page.mouse.move(mx, my);
  await page.mouse.down();
  for (let i = 1; i <= 80; i++) {
    const theta = Math.PI / 2 - Math.PI * 2 * 0.99 * (i / 80);
    await page.mouse.move(mx + Math.cos(theta) * radius, my - radius + Math.sin(theta) * radius);
  }
  await expect(page.locator('.stretch-preview .preview-rect')).toBeVisible();
  await page.mouse.up();

  const badge = page.locator('.stretch-arc-handles .rect-badge');
  await expect(badge).toContainText('Ring 360°');
  await expect(page.locator('.arc-radius-handle')).toHaveCount(1);
  await expect(page.locator('.arc-width-handle')).toHaveCount(1);

  // The width handle sits where the start edge meets the outer edge; drag it inward.
  const width = (await page.locator('.arc-width-handle').boundingBox())!;
  const pivot = (await page.locator('.arc-radius-handle').boundingBox())!;
  const grip = { x: width.x + width.width / 2, y: width.y + width.height / 2 };
  const inward = { x: pivot.x + pivot.width / 2 - grip.x, y: pivot.y + pivot.height / 2 - grip.y };
  const inwardLength = Math.hypot(inward.x, inward.y);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + inward.x / inwardLength * 30, grip.y + inward.y / inwardLength * 30, { steps: 6 });
  await page.mouse.up();
  expect(Number(await page.getByLabel('Width').inputValue())).toBeLessThan(200);

  // Pulling a hollow edge marker outward adds a spline point that reshapes that edge.
  const centreBox = (await page.locator('.arc-radius-handle').boundingBox())!;
  const marker = (await page.locator('.arc-edge-insert.outer').first().boundingBox())!;
  const from = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  const spoke = { x: from.x - (centreBox.x + centreBox.width / 2), y: from.y - (centreBox.y + centreBox.height / 2) };
  const spokeLength = Math.hypot(spoke.x, spoke.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + spoke.x / spokeLength * 30, from.y + spoke.y / spokeLength * 30, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.arc-knot.outer')).toHaveCount(1);
  await expect(page.getByText(/Edges shaped by 1 point/)).toBeVisible();
  await page.locator('.arc-knot.outer').dblclick();
  await expect(page.locator('.arc-knot')).toHaveCount(0);

  await page.getByRole('button', { name: 'Open ring' }).click();
  await expect(badge).toContainText('180°');
  await page.getByRole('group', { name: 'Band shape' }).getByRole('button', { name: 'Straight' }).click();
  await expect(page.locator('.stretch-arc-handles')).toHaveCount(0);
  await expect(page.locator('.stretch-rect-handles')).toBeVisible();
});

test('mobile editor uses a touch toolbar and layers sheet without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPhoto(page);

  const toolbar = page.locator('.toolbar');
  const toolButtons = toolbar.locator('.tool-btn');
  await expect(toolButtons).toHaveCount(4);
  await expect(toolbar.getByRole('button', { name: 'Move', exact: true })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Brush', exact: true })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Stretch', exact: true })).toHaveAttribute('aria-pressed', 'true');
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
  // A single layer has no reorder action. Duplicating reveals touch-sized controls.
  await expect(page.getByRole('button', { name: 'Move Background up' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  const moveDown = panel.getByRole('button', { name: /Move .+ down/ }).filter({ visible: true });
  await expect(moveDown).toBeEnabled();
  const orderBox = (await moveDown.boundingBox())!;
  expect(orderBox.width).toBeGreaterThanOrEqual(44);
  expect(orderBox.height).toBeGreaterThanOrEqual(44);
  await moveDown.click();
  await expect(panel.locator('.layer-row').last()).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.locator('.layer-row').first()).toHaveClass(/selected/);

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


test.describe('stretch properties on mobile', () => {
  test.setTimeout(20_000);
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  // Pick an exposed pixel inside the band, away from its handles and color grip.
  async function bodyPoint(page: import('@playwright/test').Page) {
    return page.getByRole('button', { name: 'Stretch properties', exact: true }).evaluate((element) => {
      const box = element.getBoundingClientRect();
      for (const x of [0.3, 0.7, 0.5]) {
        for (const y of [0.3, 0.7, 0.5]) {
          const point = { x: box.x + box.width * x, y: box.y + box.height * y };
          if (document.elementFromPoint(point.x, point.y) === element) return point;
        }
      }
      throw new Error('No exposed stretch body pixel');
    });
  }

  for (const shape of ['Straight', 'Arc'] as const) {
    test(`${shape}: tapping and dragging keep properties closed; double-tap opens them`, async ({ page }) => {
      await openSyntheticStretch(page);
      if (shape === 'Arc') {
        await page.getByRole('group', { name: 'Band shape' }).getByRole('button', { name: shape }).click();
      }
      const panel = page.getByLabel('Layers and properties');
      const body = page.getByRole('button', { name: 'Stretch properties', exact: true });
      const before = await body.getAttribute('d');
      const undoWasEnabled = await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled();
      await expect(panel).not.toBeVisible();
      if (shape === 'Straight') {
        await mkdir('artifacts/mobile', { recursive: true });
        await page.screenshot({ path: 'artifacts/mobile/stretch-editing.png', animations: 'disabled' });
      }

      let point = await bodyPoint(page);
      await page.touchscreen.tap(point.x, point.y);
      await expect(panel).not.toBeVisible();
      expect(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(undoWasEnabled);
      await expect(body).toHaveAttribute('d', before!);

      // A real drag changes the band without being mistaken for a tap.
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 18, point.y + 12, { steps: 5 });
      await page.mouse.up();
      await expect(body).not.toHaveAttribute('d', before!);
      await expect(panel).not.toBeVisible();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(body).toHaveAttribute('d', before!);
      expect(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(undoWasEnabled);

      point = await bodyPoint(page);
      await page.touchscreen.tap(point.x, point.y);
      await page.touchscreen.tap(point.x, point.y);
      await expect(panel).toBeVisible();
      await expect(page.getByLabel('Width')).toBeVisible();
      if (shape === 'Straight') {
        await page.screenshot({ path: 'artifacts/mobile/stretch-properties.png', animations: 'disabled' });
      }
      await page.getByRole('button', { name: 'Close panel' }).click();
      await expect(panel).not.toBeVisible();

      // Editing a handle after closing must not reopen the panel.
      const handle = page.locator(shape === 'Arc' ? '.arc-width-handle' : '.rect-handle').first();
      const grip = (await handle.boundingBox())!;
      const shapeBefore = await body.getAttribute('d');
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2 + 16, grip.y + grip.height / 2 + 12, { steps: 4 });
      await page.mouse.up();
      await expect(body).not.toHaveAttribute('d', shapeBefore!);
      await expect(panel).not.toBeVisible();

      // Mouse double-click also works, without changing the stretch geometry.
      point = await bodyPoint(page);
      await page.mouse.dblclick(point.x, point.y);
      await expect(panel).toBeVisible();
      await page.getByRole('button', { name: 'Edit path', exact: true }).click();
      await expect(page.locator('.stretch-path-editor')).toBeVisible();
      await expect(panel).not.toBeVisible();
    });
  }
});
