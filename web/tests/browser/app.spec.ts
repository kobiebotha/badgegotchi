import { authenticate, databaseRows, expect, metric, openDashboard, seedPet, test, userId } from './fixtures';

test('signed-out layout fits desktop and phone, and email-code errors stay actionable', async ({ page, backend }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Meet your companion' })).toBeVisible();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByLabel('Email address')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`sign-in-${viewport.width}.png`), fullPage: true });
  }
  await page.getByLabel('Email address').fill('browser-test@example.test');
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  expect(backend.requests.some((request) =>
    request.url.includes('/auth/v1/otp') &&
    (request.body as { email?: string })?.email === 'browser-test@example.test',
  )).toBe(true);
  await page.getByLabel('Email code').fill('123456');
  await page.getByRole('button', { name: 'Let’s settle in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That code has expired. Request a new one.');
  await page.getByRole('button', { name: 'Use a different email or resend' }).click();
  await expect(page.getByLabel('Email address')).toHaveValue('browser-test@example.test');
});

test('real PowerSync worker persists timer and wellness writes across reload during a cloud outage', async ({ context, page, backend }) => {
  await authenticate(context);
  await openDashboard(page);
  await expect(page.getByRole('alert').filter({ hasText: 'Pet cloud request failed (503)' })).toBeVisible();
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Focus session', exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveText(/^(40:00|39:5\d)$/);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Focus paused', exact: true })).toBeVisible();
  const pausedText = await page.getByRole('timer').innerText();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Focus paused', exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveText(pausedText);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Focus session', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  await expect(metric(page, 'Focus ended')).toHaveText('1');
  await page.getByRole('button', { name: /Drink water/ }).click();
  await page.getByRole('button', { name: /Move & stretch/ }).click();
  await expect(metric(page, 'Glasses of water')).toHaveText('1');
  await expect(metric(page, 'Movement breaks')).toHaveText('1');
  await expect(page.getByText('Your changes are saved on this device. Sync will retry automatically.')).toBeVisible();
  const sessions = await databaseRows(page, 'SELECT state, outcome FROM sessions');
  expect(sessions).toEqual([{ state: 'ended', outcome: 'stopped' }]);
  expect((await databaseRows(page, 'SELECT id FROM wellness_events')).length).toBe(2);
  await page.reload();
  await expect(metric(page, 'Focus ended')).toHaveText('1');
  await expect(metric(page, 'Glasses of water')).toHaveText('1');
  await expect(metric(page, 'Movement breaks')).toHaveText('1');
  const pendingUploads = await page.evaluate(async ({ userId }) => {
    const modulePath = '/src/lib/database.ts';
    const { openUserDatabase } = await import(modulePath);
    return (await (await openUserDatabase(userId)).getUploadQueueStats()).count;
  }, { userId });
  expect(pendingUploads).toBeGreaterThan(0);
  expect(backend.requests.some((request) => request.url.includes('/functions/v1/pet-ai'))).toBe(true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'You have unsynced changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep going', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(metric(page, 'Focus ended')).toHaveText('1');
  await expect(metric(page, 'Glasses of water')).toHaveText('1');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes & sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Meet your companion' })).toBeVisible();
  // The fake session is reinstalled by authenticate on reload. This opens the
  // same user's database again and checks the real SDK cleared its local rows.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Let’s find your rhythm.' })).toBeVisible();
  await expect(metric(page, 'Focus ended')).toHaveText('0');
  await expect(metric(page, 'Glasses of water')).toHaveText('0');
  await expect(metric(page, 'Movement breaks')).toHaveText('0');
});

test('seeded companion queues one pet intention and retains local wellness while the pet is waiting', async ({ context, page, backend }) => {
  await authenticate(context);
  await openDashboard(page);
  await seedPet(page);
  await expect(page.getByRole('img', { name: 'Pebble, your capybara companion' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('dashboard-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Pet Pebble', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pet Pebble', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /Drink water/ }).click();
  await expect(metric(page, 'Glasses of water')).toHaveText('1');
  expect(await databaseRows(page, 'SELECT event_type, source_device, status FROM pet_events')).toEqual([
    { event_type: 'pet_pet', source_device: 'web', status: 'pending' },
  ]);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('dashboard-mobile.png'), fullPage: true });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pebble', exact: true })).toBeVisible();
  await expect(metric(page, 'Glasses of water')).toHaveText('1');
  expect(backend.requests.filter((request) => request.url.includes('/rest/v1/pet_sessions'))).toHaveLength(0);
});

test('an overdue persisted timer completes once after restoration and offers the 10-minute break', async ({ context, page, backend }) => {
  void backend;
  await authenticate(context);
  await openDashboard(page);
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Focus session', exact: true })).toBeVisible();
  const expireTimer = () => page.evaluate(async ({ userId }) => {
      const modulePath = '/src/lib/database.ts';
      const { openUserDatabase } = await import(modulePath);
      const db = await openUserDatabase(userId);
      const elapsed = new Date(Date.now() - 41 * 60 * 1000).toISOString();
      await db.execute("UPDATE sessions SET last_resumed_at = ? WHERE state = 'active'", [elapsed]);
    }, { userId });
  await expireTimer();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Focus complete', exact: true })).toBeVisible();
  await expect(metric(page, 'Focus ended')).toHaveText('1');
  await expect(page.getByRole('timer')).toHaveText('00:00');
  expect(await databaseRows(page, 'SELECT state, outcome FROM sessions')).toEqual([
    { state: 'ended', outcome: 'completed' },
  ]);
  await page.getByRole('button', { name: 'Skip break', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Focus complete', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Focus session', exact: true })).toBeVisible();
  await expireTimer();
  await expect(page.getByRole('heading', { name: 'Focus complete', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start a 10 min break' }).click();
  await expect(page.getByRole('heading', { name: 'Break session', exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveText(/^(10:00|09:5\d)$/);
  expect((await databaseRows(page, "SELECT planned_duration_seconds FROM sessions WHERE state = 'active'"))[0])
    .toEqual({ planned_duration_seconds: 600 });
  await expect(metric(page, 'Focus ended')).toHaveText('2');
});
