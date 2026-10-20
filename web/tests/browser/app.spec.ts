import { authenticate, databaseRows, expect, metric, openDashboard, seedPet, test, userId } from './fixtures';

test('signed-out layout fits desktop and phone and requests an email code', async ({ page, backend }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Meet your companion' })).toBeVisible();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByLabel('Email address')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`sign-in-${viewport.width}.png`), fullPage: true });
  }
  await page.getByLabel('Email address').fill('browser-test@example.test');
  await page.getByRole('button', { name: 'Send email code' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your email code' })).toBeVisible();
  await expect(page.getByText('Enter the sign-in code sent to browser-test@example.test.')).toBeVisible();
  const requests = backend.requests.filter((request) => request.url.includes('/auth/v1/otp'));
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toMatchObject({ email: 'browser-test@example.test' });
  await expect(page.getByRole('button', { name: /^Resend code \(\d+s\)$/ })).toBeDisabled();
  await expect(page.getByText(/sign-in link|Mac app/)).toHaveCount(0);
});

test('email code can be retried after an error without duplicate send or verify requests', async ({ page, backend }) => {
  await page.goto('/');
  await page.getByLabel('Email address').fill('retry@example.test');
  const releaseSend = backend.holdAuthResponses();
  try {
    await page.getByRole('button', { name: 'Send email code' }).click();
    await expect(page.getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled();
    // Bypass disabled buttons to exercise the synchronous request guard as well.
    await page.locator('form').evaluate((form: HTMLFormElement) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => backend.requests.filter((request) => request.url.includes('/auth/v1/otp')).length).toBe(1);
  } finally {
    releaseSend();
  }
  await expect(page.getByLabel('Email code', { exact: true })).toBeEnabled();
  await page.getByLabel('Email code', { exact: true }).fill('12345678');
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('That code has expired. Request a new one.');
  await expect(page.getByLabel('Email code', { exact: true })).toBeEnabled();
  backend.acceptCode('87654321');
  await page.getByLabel('Email code', { exact: true }).fill('87654321');
  const releaseVerify = backend.holdAuthResponses();
  try {
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Verifying…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Use a different email', exact: true })).toBeDisabled();
    await page.locator('form').evaluate((form: HTMLFormElement) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => backend.requests.filter((request) => request.url.includes('/auth/v1/verify')).length).toBe(2);
  } finally {
    releaseVerify();
  }
  await expect(page.getByRole('heading', { name: 'Let’s find your rhythm.' })).toBeVisible();
  expect(backend.requests.filter((request) => request.url.includes('/auth/v1/otp'))).toHaveLength(1);
  expect(backend.requests.filter((request) => request.url.includes('/auth/v1/verify')).map((request) => {
    const { email, token, type } = request.body as { email: string; token: string; type: string };
    return { email, token, type };
  }))
    .toEqual([
      { email: 'retry@example.test', token: '12345678', type: 'email' },
      { email: 'retry@example.test', token: '87654321', type: 'email' },
    ]);
});

test('an existing email code can be verified without requesting another email', async ({ page, backend }) => {
  await page.goto('/');
  const emailInput = page.getByLabel('Email address');
  await page.getByRole('button', { name: 'I already have a code', exact: true }).click();
  expect(await emailInput.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await emailInput.fill('not-an-email');
  await page.getByRole('button', { name: 'I already have a code', exact: true }).click();
  expect(await emailInput.evaluate((input: HTMLInputElement) => input.validity.typeMismatch)).toBe(true);
  await expect(page.getByLabel('Email code', { exact: true })).toHaveCount(0);
  expect(backend.requests.filter((request) => request.url.includes('/auth/v1/otp'))).toHaveLength(0);
  await emailInput.fill('manual@example.test');
  await page.getByRole('button', { name: 'I already have a code', exact: true }).click();
  await expect(page.getByText('Enter the sign-in code for manual@example.test.')).toBeVisible();
  await expect(page.getByText(/code sent to|new code is on its way/)).toHaveCount(0);
  await expect(page.getByLabel('Email code', { exact: true })).toBeEnabled();
  expect(backend.requests.filter((request) => request.url.includes('/auth/v1/otp'))).toHaveLength(0);
  backend.acceptCode('87654321');
  await page.getByLabel('Email code', { exact: true }).fill('87654321');
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Let’s find your rhythm.' })).toBeVisible();
  expect(backend.requests.filter((request) => request.url.includes('/auth/v1/otp'))).toHaveLength(0);
  const verification = backend.requests.filter((request) => request.url.includes('/auth/v1/verify'));
  expect(verification).toHaveLength(1);
  expect(verification[0].body).toMatchObject({ email: 'manual@example.test', token: '87654321', type: 'email' });
});

test('resending waits 60 seconds, keeps the email, and switching addresses starts a fresh code flow', async ({ page, backend }) => {
  await page.clock.install({ time: new Date('2026-10-20T16:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-20T16:00:01Z'));
  await page.goto('/');
  await page.getByLabel('Email address').fill('browser-test@example.test');
  await page.getByRole('button', { name: 'Send email code' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your email code' })).toBeVisible();
  await page.getByLabel('Email code', { exact: true }).fill('12345678');
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Resend code \(\d+s\)$/ })).toBeDisabled();
  await page.clock.fastForward(59_000);
  await expect(page.getByRole('button', { name: /^Resend code \(\d+s\)$/ })).toBeDisabled();
  expect(backend.requests.filter((request) => request.url.includes('/auth/v1/otp'))).toHaveLength(1);
  await page.clock.fastForward(1_000);
  await page.getByRole('button', { name: 'Resend code', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('A new code is on its way. Use the newest email.');
  await expect(page.getByLabel('Email code', { exact: true })).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const resendRequests = backend.requests.filter((request) => request.url.includes('/auth/v1/otp'));
  expect(resendRequests).toHaveLength(2);
  expect(resendRequests.map((request) => (request.body as { email: string }).email))
    .toEqual(['browser-test@example.test', 'browser-test@example.test']);
  await page.getByRole('button', { name: 'Use a different email', exact: true }).click();
  await expect(page.getByLabel('Email address')).toHaveValue('browser-test@example.test');
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.getByLabel('Email address').fill('different@example.test');
  await page.getByRole('button', { name: 'Send email code' }).click();
  await expect(page.getByText('Enter the sign-in code sent to different@example.test.')).toBeVisible();
  expect(backend.requests.filter((request) => request.url.includes('/auth/v1/otp')).at(-1)?.body)
    .toMatchObject({ email: 'different@example.test' });
});

test('email rate limits explain send failures and preserve an existing code after resend fails', async ({ page, backend }) => {
  const emailLimitMessage = 'Sign-in emails are temporarily unavailable because the email service has reached its sending limit. Please try again later.';
  const requestLimitMessage = 'Too many sign-in requests right now. Please wait a little before trying again.';
  await page.clock.install({ time: new Date('2026-10-20T16:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-20T16:00:01Z'));
  await page.goto('/');
  await page.getByLabel('Email address').fill('limited@example.test');
  backend.failNextEmailRequest({ status: 429, code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' });
  await page.getByRole('button', { name: 'Send email code' }).click();
  await expect(page.getByRole('alert')).toHaveText(emailLimitMessage);
  await expect(page.getByLabel('Email address')).toHaveValue('limited@example.test');
  await expect(page.getByLabel('Email code', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);

  for (const code of ['over_request_rate_limit', undefined]) {
    backend.failNextEmailRequest({ status: 429, code, message: 'rate limit exceeded' });
    await page.getByRole('button', { name: 'Send email code' }).click();
    await expect(page.getByRole('alert')).toHaveText(requestLimitMessage);
    await expect(page.getByLabel('Email code', { exact: true })).toHaveCount(0);
  }

  await page.getByRole('button', { name: 'Send email code' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your email code' })).toBeVisible();
  await page.getByLabel('Email code', { exact: true }).fill('87654321');
  await page.clock.fastForward(60_000);
  backend.failNextEmailRequest({ status: 429, code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' });
  await page.getByRole('button', { name: 'Resend code', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(emailLimitMessage);
  await expect(page.getByLabel('Email code', { exact: true })).toHaveValue('87654321');
  await expect(page.getByRole('button', { name: 'Verify code', exact: true })).toBeEnabled();
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(backend.requests.filter((request) => request.url.includes('/auth/v1/otp'))).toHaveLength(5);
  backend.acceptCode('87654321');
  await page.clock.resume();
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Let’s find your rhythm.' })).toBeVisible();
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
