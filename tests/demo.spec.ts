import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('empty home offers the editable skate demo without downloading it in advance', async ({ page }) => {
  const projectRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/skate_sample.pixelstretch')) projectRequests.push(request.url());
  });
  await page.goto('/');
  const demo = page.getByRole('button', { name: 'Open skate demo' });
  await expect(demo).toBeVisible();
  await expect(demo.locator('img')).toHaveJSProperty('naturalWidth', 320);
  expect(projectRequests).toHaveLength(0);
  await page.screenshot({ path: 'artifacts/home-demo-mobile.png' });
  await demo.click();
  await expect(page.locator('.editor-canvas-wrapper')).toBeVisible();
  expect(projectRequests).toHaveLength(1);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Band shape', exact: true }).click();
  await expect(page.locator('#stretch-shapes')).toBeVisible();
});

test('home hides the demo when a recent image exists, including after reload', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[accept^="image/"]').setInputFiles('public/skate_sample.webp');
  await expect(page.locator('.editor-canvas-wrapper')).toBeVisible();
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('button', { name: 'Back to home' }).click();
  await expect(page.getByRole('region', { name: 'Recent images' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open skate demo' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Recent images' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open skate demo' })).toHaveCount(0);
});

test('a failed demo load shows an error and can be retried', async ({ page }) => {
  await page.route('**/skate_sample.pixelstretch', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open skate demo' }).click();
  await expect(page.locator('.upload-error')).toHaveText('Could not load the skate demo. Please try again.');
  await page.unroute('**/skate_sample.pixelstretch');
  await page.getByRole('button', { name: 'Open skate demo' }).click();
  await expect(page.locator('.editor-canvas-wrapper')).toBeVisible();
});
