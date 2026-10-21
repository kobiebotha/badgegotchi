import { authenticate, expect, metric, openDashboard, test } from './fixtures';

test('production WASM workers load account data without inventing offline totals', async ({context,page,backend}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await authenticate(context);
  await openDashboard(page);
  await expect(metric(page,'Glasses of water')).toHaveText('—');
  await expect(metric(page,'Focus ended')).toHaveText('—');
  await expect(page.getByText('Waiting for account totals…')).toBeVisible();
  await expect(page.getByRole('button',{name:/Drink water/})).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Let’s find your rhythm.'})).toBeVisible();
  await expect(metric(page,'Movement breaks')).toHaveText('—');
  await expect.poll(()=>backend.requests.some(r=>r.url.includes('/functions/v1/badge-gateway') && (r.body as {action?:string})?.action === 'refresh')).toBe(true);
  expect(errors).toEqual([]);
  expect(backend.requests.every(r=>new URL(r.url).hostname.endsWith('.test'))).toBe(true);
  await page.screenshot({path:test.info().outputPath('production-account-dashboard.png'),fullPage:true});
});
