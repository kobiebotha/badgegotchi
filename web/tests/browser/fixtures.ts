import { expect, test as base } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

export const userId = '11111111-1111-4111-8111-111111111111';
const email = 'browser-test@example.test';
const storageKey = 'sb-badgegotchi-auth-token';

function sessionForTest(emailAddress = email) {
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
      sub: userId, role: 'authenticated', aud: 'authenticated', exp: expiresAt,
    })}.browser-test-signature`,
    token_type: 'bearer',
    refresh_token: 'browser-test-refresh-token',
    expires_in: 24 * 60 * 60,
    expires_at: expiresAt,
    user: {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email: emailAddress,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

interface MockBackend {
  requests: { url: string; method: string; body: unknown }[];
  acceptCode(code: string): void;
  holdAuthResponses(): () => void;
  failNextEmailRequest(error: { status: number; code?: string; message: string }): void;
}

export const test = base.extend<{ backend: MockBackend }>({
  backend: async ({ context }, use) => {
    const requests: MockBackend['requests'] = [];
    let acceptedCode: string | null = null;
    let authGate: Promise<void> | null = null;
    const emailFailures: { status: number; code?: string; message: string }[] = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === 'http://127.0.0.1:5173') {
        await route.continue();
        return;
      }
      let body: unknown;
      try { body = request.postDataJSON(); } catch { body = request.postData(); }
      requests.push({ url: request.url(), method: request.method(), body });
      const json = (status: number, payload: unknown) => route.fulfill({
        status,
        contentType: 'application/json',
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Expose-Headers': 'X-Supabase-Api-Version',
          // auth-js reads response.code only for versioned Auth responses.
          'X-Supabase-Api-Version': '2024-01-01',
        },
        body: JSON.stringify(payload),
      });
      if (url.hostname === 'badgegotchi.supabase.test' && url.pathname.startsWith('/auth/v1/')) {
        if (authGate) await authGate;
        if (url.pathname === '/auth/v1/otp') {
          const failure = emailFailures.shift();
          return failure
            ? json(failure.status, { code: failure.code, message: failure.message })
            : json(200, {});
        }
        if (url.pathname === '/auth/v1/user') return json(200, sessionForTest().user);
        if (url.pathname === '/auth/v1/token') return json(200, sessionForTest());
        if (url.pathname === '/auth/v1/verify') {
          const submitted = body as { token?: string; email?: string };
          return acceptedCode && submitted.token === acceptedCode
            ? json(200, sessionForTest(submitted.email))
            : json(422, {
              code: 'otp_expired', message: 'That code has expired. Request a new one.',
            });
        }
        if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
      }
      if (url.hostname === 'badgegotchi.supabase.test' || url.hostname === 'sync.badgegotchi.test') {
        return json(503, { message: 'Simulated cloud outage for browser testing.' });
      }
      // No external request may reach a live service, including accidental URLs.
      await route.abort('blockedbyclient');
    });
    await use({
      requests,
      acceptCode(code) { acceptedCode = code; },
      failNextEmailRequest(error) { emailFailures.push(error); },
      holdAuthResponses() {
        let release!: () => void;
        authGate = new Promise<void>((resolve) => { release = resolve; });
        return () => { authGate = null; release(); };
      },
    });
  },
});

export { expect };

export async function authenticate(context: BrowserContext): Promise<void> {
  await context.addInitScript(({ key, session }) => {
    // Reapply on reload to exercise persistent SQLite without live auth.
    if (location.origin === 'http://127.0.0.1:5173') {
      localStorage.setItem(key, JSON.stringify(session));
    }
  }, { key: storageKey, session: sessionForTest() });
}

export async function openDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Let’s find your rhythm.' })).toBeVisible();
  if (process.env.BROWSER_BUILD === 'production') {
    await expect(page.getByRole('button', { name: 'Restoring your timer…', exact: true })).toBeDisabled();
    return;
  }
  await seedAccountProjection(page);
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
}

export function metric(page: Page, name: string) {
  return page.locator('.metric').filter({ hasText: name }).locator('strong');
}

/** Runs actual SQL through the same PowerSync worker instance used by the UI. */
export async function databaseRows(page: Page, sql: string) {
  return page.evaluate(async ({ userId, sql }) => {
    const modulePath = '/src/lib/database.ts';
    const { openUserDatabase } = await import(modulePath);
    const db = await openUserDatabase(userId);
    return await db.getAll(sql) as Record<string, unknown>[];
  }, { userId, sql });
}

export async function seedPet(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Pebble', exact: true })).toBeVisible();
}

/** A downloaded account baseline; fixture writes are acknowledged before actions. */
export async function seedAccountProjection(page: Page): Promise<void> {
  await page.evaluate(async ({ userId }) => {
    const modulePath = '/src/lib/database.ts';
    const { openUserDatabase } = await import(modulePath);
    const db = await openUserDatabase(userId);
    if (await db.getOptional("SELECT id FROM badge_projection WHERE kind = 'timer'")) return;
    await db.disconnect();
    const day = new Date().toISOString().slice(0,10);
    for (const [kind,payload] of [
      ['timer', { revision:'0',id:null,type:'focus',state:'idle',planned_duration_seconds:2400,
        started_at:null,last_resumed_at:null,paused_at:null,remaining_seconds_at_pause:2400 }],
      ['summary', { day_key:day,ended_focus_count:0,ended_break_count:0,hydration_count:0,movement_count:0,pet_count:0 }],
    ] as const) await db.execute('INSERT OR REPLACE INTO badge_projection (id,kind,payload) VALUES (?,?,?)', [userId+':'+kind,kind,JSON.stringify(payload)]);
    const stamp = new Date().toISOString();
    await db.execute(`INSERT INTO pet_sessions
      (id, animal_id, bio_name, bio_summary, latest_speech, created_at, updated_at)
      VALUES (?, 'capybara', 'Pebble', 'A patient little friend.', 'One good moment at a time.', ?, ?)`,
      ['22222222-2222-4222-8222-222222222222',stamp,stamp]);
    for (let tx = await db.getNextCrudTransaction(); tx; tx = await db.getNextCrudTransaction()) await tx.complete();
    const connectorPath = '/src/lib/connector.ts';
    const supabasePath = '/src/lib/supabase.ts';
    const configPath = '/src/lib/config.ts';
    const [{SupabaseConnector},{getSupabaseClient},{requireConfig}] = await Promise.all([import(connectorPath),import(supabasePath),import(configPath)]);
    void db.connect(new SupabaseConnector(getSupabaseClient(),requireConfig(),userId)).catch(() => undefined);
  }, {userId});
}
