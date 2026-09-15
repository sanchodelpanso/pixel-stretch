import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function openWorkspace(page: Page, band = true) {
  const project = JSON.parse(await readFile('PixelStretch.pixelstretch', 'utf8'));
  const source = project.layers[0];
  project.layers = [source];
  project.selectedLayerId = source.id;
  if (band) {
    project.selectedLayerId = 'workspace-test-band';
    project.layers.push({ ...source, id: project.selectedLayerId, name: 'Stretch',
      stretch: { points: [{ x: 150, y: 300 }, { x: 550, y: 300 }], sourceLayerId: source.id,
        anchor: { x: 150, y: 300 }, width: 400, length: -400, rotation: 0, fade: 0, edgeSoftness: 0, bend: 0 } });
  }
  await page.goto('/');
  await page.locator('input[accept*=".pixelstretch"]').setInputFiles({
    name: 'workspace.pixelstretch', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.editor-canvas-wrapper')).toBeVisible();
}

test('compact workspace, bottom menus and layers fit phone and desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await expect(page.locator('.editor-header, .toolbar, .editor-hint')).toHaveCount(0);
  await expect(page.locator('.right-panel')).toBeHidden();
  const canvas = (await page.locator('.editor-canvas-wrapper').boundingBox())!;
  expect(canvas.height).toBeGreaterThan(650);
  const dock = (await page.locator('.editor-dock').boundingBox())!;
  expect(dock.y).toBeGreaterThan(760);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(page.locator('.right-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Project menu' }).click();
  await expect(page.getByRole('button', { name: 'Save project' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export PNG' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to home' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Project menu' })).toBeFocused();
  await page.getByRole('button', { name: 'Stretch style', exact: true }).click();
  const menu = (await page.locator('#stretch-styles').boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(0);
  expect(menu.y + menu.height).toBeLessThan(dock.y);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'artifacts/workspace-mobile.png' });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole('button', { name: 'More stretch actions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit path', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'artifacts/workspace-desktop.png' });
});

test('Cmd-drag pans without editing, changes cursor and can center again', async ({ page }) => {
  await openWorkspace(page);
  const wrapper = page.locator('.editor-canvas-wrapper');
  const outline = await page.locator('.rect-outline').getAttribute('d');
  const before = (await wrapper.boundingBox())!;
  const handle = (await page.locator('.rect-handle').first().boundingBox())!;
  await page.keyboard.down('Meta');
  await expect(page.locator('.editor-stage')).toHaveCSS('cursor', 'grab');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await expect(page.locator('.editor-stage')).toHaveCSS('cursor', 'grabbing');
  await page.mouse.move(handle.x + handle.width / 2 + 75, handle.y + handle.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Meta');
  const after = (await wrapper.boundingBox())!;
  expect(after.x - before.x).toBeCloseTo(75, 0);
  expect(after.y - before.y).toBeCloseTo(40, 0);
  await expect(page.locator('.rect-outline')).toHaveAttribute('d', outline!);
  await page.getByRole('button', { name: 'Project menu' }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Center image' }).click();
  await expect(wrapper).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
});

test('two fingers pan, cancel first-finger editing, and ignore the remaining finger', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openWorkspace(page, false);
  const cdp = await context.newCDPSession(page);
  const wrapper = page.locator('.editor-canvas-wrapper');
  const before = (await wrapper.boundingBox())!;
  const x = before.x + before.width / 2, y = before.y + before.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }, { id: 2, x: x + 55, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + 30, y: y + 60 }, { id: 2, x: x + 85, y: y + 60 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ id: 1, x: x + 30, y: y + 60 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + 70, y: y + 80 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const after = (await wrapper.boundingBox())!;
  expect(after.x - before.x).toBeCloseTo(30, 0);
  expect(after.y - before.y).toBeCloseTo(60, 0);
  await expect(page.locator('.stretch-path-editor, .stretch-preview')).toHaveCount(0);
  await expect(page.locator('.right-panel')).toBeHidden();
  // A later single-finger gesture still draws normally at the panned coordinates.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 3, x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 3, x: x + 70, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('button', { name: 'Finish sample path' })).toBeVisible();
  await context.close();
});

test('two-finger pan over a handle restores geometry and single-finger editing still works', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openWorkspace(page);
  const cdp = await context.newCDPSession(page);
  const outline = page.locator('.rect-outline');
  const original = await outline.getAttribute('d');
  const handle = (await page.locator('.rect-handle').first().boundingBox())!;
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + 4, y: y + 4 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x + 4, y: y + 4 }, { id: 2, x: x + 70, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + 24, y: y + 34 }, { id: 2, x: x + 90, y: y + 30 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(outline).toHaveAttribute('d', original!);
  await expect(page.locator('.right-panel')).toBeHidden();
  const next = (await page.locator('.rect-handle').first().boundingBox())!;
  const nx = next.x + next.width / 2, ny = next.y + next.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 3, x: nx, y: ny }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 3, x: nx + 20, y: ny + 10 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(outline).not.toHaveAttribute('d', original!);
  await expect(page.locator('.right-panel')).toBeHidden();
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(outline).toHaveAttribute('d', original!);
  await page.getByRole('button', { name: 'Project menu' }).click();
  const bounds = (await outline.boundingBox())!;
  const tap = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.touchscreen.tap(tap.x, tap.y);
  await page.touchscreen.tap(tap.x, tap.y);
  await expect(page.locator('.right-panel')).toBeVisible();
  await expect(page.locator('.panel-mobile-header')).toContainText('Stretch properties');
  await context.close();
});
