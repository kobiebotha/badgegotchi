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

Open [localhost:5173](http://localhost:5173). Sign in by entering the one-time
code from the email. New and returning users use the same flow: verifying the
code also confirms the email address. There is no separate confirmation link.
Resending is available after 60 seconds; use the newest code in your inbox.
Restart the dev server after changing environment settings.

Both Supabase Auth email templates, **Confirm signup** and **Magic Link**, must
use [`sign-in-code.html`](../supabase/templates/sign-in-code.html) with the subject
**Your Badgegotchi sign-in code**. The template uses `{{ .Token }}`; the default
link-only templates do not send a code. Both are configured in
[`supabase/config.toml`](../supabase/config.toml) for local development, with email
confirmation enabled and eight-digit codes. For a new hosted project, set both
templates in its Auth email-template settings. Code verification establishes the
session in the requesting browser and does not depend on redirect allowlists.

Supabase's built-in email sender is for initial testing. Its current limit is
**two messages per hour for the entire project**, shared across signup, sign-in,
and recovery emails. Changing the recipient or using a `+test` alias does not
create a new quota. It also restricts delivery to organization team addresses.
Configure [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp) with a
verified sender before testing with other people or using email sign-in in
production. SMTP credentials belong in hosted Supabase Auth settings, never in
`VITE_*` variables. The app's 60-second resend cooldown is separate from the
project-wide sending quota; a cooldown ending does not guarantee mail can send.

### PowerSync diagnostics

Development runs include [PowerSync DevTools](https://docs.powersync.com/tools/devtools/vite).
Open the PowerSync entry in the dock at the bottom of the page. On first use,
authorize your browser with the code printed in the Vite terminal. Keep the
signed-in app tab open so DevTools can attach to its database.

Check Sync Status and the upload queue before changing data. The MCP endpoint is
`http://127.0.0.1:5173/__devtools/__mcp` (use the actual dev server port), with
the header `Origin: http://127.0.0.1:5173`. Start with `powersync_sources`,
`powersync_status`, and `powersync_upload-queue`; use the returned database ID
when multiple tabs are attached. `powersync_info` includes the current JWT,
so do not copy its raw response into logs or bug reports. `clearData` deletes
pending writes as well as synced data.

DevTools runs only on the development server and is excluded from production
builds. The SDK's additional bucket diagnostics are enabled only in development.

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
3. Configure both hosted Auth email templates as described above. Keep any
   redirect URLs still needed by other authentication flows.

These backend prerequisites are not applied by `npm run build`.
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
environment. Environment changes require a rebuild because Vite
replaces these values at build time. [`vercel.json`](vercel.json) contains the SPA
fallback and response headers.

Building the app does not deploy it. Deployment to the **powersync Vercel
organization requires the project owner's approval**. Do not run `git push`;
the owner handles pushes.

## Behavior and contracts

### Badge installer

Open `/install`, or choose **Set up a badge** from the header. This public page
does not depend on sign-in and uses WebUSB/PICOBOOT in desktop Chrome or Edge.
It verifies the published UF2 before connecting, asks for the badge model and
firmware replacement confirmation, then writes, reads back, and reboots.
Other browsers can download the same verified UF2 for manual BOOTSEL installation.

**No firmware release is published yet.** The shipped manifest explicitly contains
`release: null`, so installation and download stay unavailable. The native
RAM-only experiments are not a firmware release. A real Tufty build and physical
USB qualification are still required. Wi-Fi setup and account pairing are
separate follow-up work.

See [badge installer development and release instructions](../docs/badge-installer.md).
`npm run firmware:prepare -- --uf2 /path/to/badgegotchi.uf2 --version 0.1.0`
stages a qualified image locally. Every build checks the manifest, file size,
SHA-256, and UF2 structure. Nothing is deployed by these commands.

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
