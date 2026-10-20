# Badgegotchi web

React app using the PowerSync Web SDK and Supabase backend. Sign in with the
same email across browsers to sync timer, wellness, and pet state.

## Run locally

Use Node.js **22.13 or newer** and npm. From the repository root:

```sh
cd web
npm ci
cp .env.example .env.local
```

Set the three public client settings in `.env.local`:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-publishable-or-anon-key
VITE_POWERSYNC_URL=https://your-instance.powersync.journeyapps.com
```

`VITE_SUPABASE_PUBLISHABLE_KEY` is also supported and takes precedence over
`VITE_SUPABASE_ANON_KEY`. These values are bundled into the browser app; never
include a service-role, database, or OpenAI secret. `.env.local` is ignored by Git.

```sh
npm run dev
```

Open [localhost:5173](http://localhost:5173). Configure Supabase Auth's redirect
allowlist to include `http://localhost:5173/`. If using the development server's
`http://127.0.0.1:5173/` address, allowlist that URL too.

Sign in with an email link or the email's six- or eight-digit code. The default
link returns to the current app origin. Set optional `VITE_AUTH_REDIRECT_URL`
when a specific callback URL is needed, and add that exact URL to the allowlist.
Restart the dev server after changing environment settings.

## Backend prerequisite

The existing backend already supplies Supabase Auth, the Data API with row-level
security, the `pet-ai` function, and five owner-filtered PowerSync streams.
The web client reuses those services and does not require a new PowerSync
instance or stream configuration.

Browser pet events use `source_device: "web"`. Before enabling them against the
cloud backend:

1. Apply
   [`20261020170338_pet_events_web_source.sql`](../supabase/migrations/20261020170338_pet_events_web_source.sql)
   to the intended Supabase database.
2. Redeploy the updated [`pet-ai`](../supabase/functions/pet-ai/handler.ts) function,
   which accepts that source value.
3. Add the final Vercel app URL to the Supabase Auth redirect allowlist, retaining
   the local development redirects and any redirects still used by existing clients.

These changes are prepared locally. They are not applied by `npm run build`.
Until both backend updates are deployed, browser pet-event uploads can be
rejected and remain queued; the app displays the upload error. Use the existing
server-side OpenAI configuration.

The backend continues to accept `macos` and `ios` source values for historical
data and existing clients, plus `badge` for future badge integration. The app in
this repository sends `web`.

## Vercel configuration

Create or connect the intended Vercel project with:

| Setting | Value |
| --- | --- |
| Root directory | `web` |
| Framework | Vite |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node.js | A supported version satisfying Node.js 22.13 or newer |

Set the public environment variables above for each intended deployment
environment. Add `VITE_AUTH_REDIRECT_URL` only if the default current-origin
redirect is unsuitable. Environment changes require a rebuild because Vite
replaces these values at build time. [`vercel.json`](vercel.json) contains the SPA
fallback and response headers.

Building the app does not deploy it. Deployment to the **powersync Vercel
organization requires the project owner's approval**. Do not run `git push`;
the owner handles pushes.

## Behavior and contracts

- Focus lasts 40 minutes and breaks last 10 minutes, with pause, resume, stop,
  completion, and timestamp-based recovery after backgrounding.
- Water and movement logs, hydration reminder state, and daily totals use UTC
  day boundaries. Totals derive from raw activity rows; cached counters
  are not uploaded over another device's data.
- Pet artwork lives in `public/assets/`. Pet creation, resets, and AI
  reactions remain server-owned. Reset retries reuse their request UUID.
- The schema matches `sessions`, `wellness_events`, `daily_activity_summary`,
  `pet_sessions`, and `pet_events`. React reads the local SQLite database with
  PowerSync hooks; timer and wellness commands write locally first. A local-only
  `ui_state` table remembers dismissed completion prompts across reloads.
- The connector sends allowlisted timer, wellness, and reminder fields to the
  Supabase Data API. Pet-event inserts send only their intent to `pet-ai` with
  `action: "react"`. Creation and reset use `ensure_pet` and `reset_pet`. Pet
  results arrive through sync rather than client writes to `pet_sessions`.
- Each upload uses a fresh session lookup and pins the checked account's token
  to its request. Failed uploads remain queued. Account-specific IndexedDB
  databases survive React remounts; sign-out clears the local database and
  warns before discarding pending changes.

Once the app is loaded and account data is available, local timer and wellness
changes persist in browser storage and queue while offline. Pet creation, pet
reset, and new AI replies need a connection. This app has **no service worker**:
it does not guarantee a cold start or page reload while offline. Browser storage
can also be cleared or evicted by the browser.

## Verify

From `web`:

```sh
npm test
npm run build
npx playwright install chromium
npx playwright test
BROWSER_BUILD=production npx playwright test
```

`npm run test:browser` is an alias for the Playwright command. The browser test
server uses port 5173; stop a separate dev server on that port before running it.
The production variant builds with reserved test service URLs and checks the
emitted SQLite WASM and worker assets through Vite Preview. Run `npm run build`
again afterward before using `dist` for a real deployment.

Vitest covers timer transitions, daily summaries, upload contracts, retries, and
account isolation. Playwright exercises the browser app with mocked cloud
endpoints and real PowerSync SQLite workers. It does not validate the deployed
Supabase function, live PowerSync replication, or OpenAI inference. Chromium
installation is only needed once per browser version.
To use an existing Google Chrome installation instead of downloading Chromium,
run `PLAYWRIGHT_CHANNEL=chrome npm run test:browser`.

To inspect the production build locally:

```sh
npm run preview
```

Vite 8 uses native top-level await with `build.target: "esnext"`, ES module
workers, and `vite-plugin-wasm`. It does not use `vite-plugin-top-level-await`.
Use a modern browser with WebAssembly, IndexedDB, and worker support; production
must be served over HTTPS.
