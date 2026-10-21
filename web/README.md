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

The web and badge share the gateway's account command contract and the same
`badge_projection` timer/summary rows. Before activating this client, apply
[`20261020224246_shared_account_commands.sql`](../supabase/migrations/20261020224246_shared_account_commands.sql),
deploy the updated `badge-gateway` and `pet-ai` functions, and deploy the
owner-filtered `account_projection` browser stream. The existing badge stream
continues to require its separate device-scoped issuer. See the activation
handoff for the approved target and release sequence; `npm run build` does not
apply backend changes or deploy anything.

Commands use the signed-in browser session, never badge credentials or server
secrets. Timer controls compare the shared revision atomically; retries reuse
the exact command ID and payload. The gateway owns wellness rows, timer history,
pet intentions and receipts, while the AI worker owns generated pet responses.
Older queued timer row edits are retained and shown as an upgrade conflict;
they cannot overwrite the shared timer. Legacy wellness/pet uploads remain
supported during the transition. Disable legacy direct writes only after the
updated clients have been released and pending old writes have been reviewed.

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
does not depend on sign-in. It adds a new `apps/badgegotchi` directory to the
ordinary Badgeware USB file drive, preserving the firmware, launcher, other apps,
and data. It verifies every download before offering a ZIP or browser copy.
Browser copy requires directory access and Web Locks, checks the Badgeware drive,
refuses an existing app, and verifies each copied file. Other browsers can use
the verified ZIP and file-manager instructions. Double-tap RESET for the file
drive; BOOTSEL is not used.

The Tufty 2350 app source supports pair-once account authentication and shared
account activity through SQLite and PowerSync. The public installer serves the
exact version in its release manifest; source changes do not publish a package.
Read that build's physical qualification results before publishing it.

See [badge installer development and release instructions](../docs/badge-installer.md).
From the repository root, `python3 badge/tools/package.py --stage-web` stages
the package. `npm run app:check` (also run before each web build) checks the
manifest, file sizes, and SHA-256 digests. Nothing is deployed by these commands.

- Focus lasts 40 minutes and breaks last 10 minutes. Completion creates the
  opposite phase paused; stopping creates the same phase paused. Starting that
  phase is an explicit action on either device. Timer time derives from the
  shared UTC timestamps and saved pause balance.
- Daily focus/break totals count ended sessions, including stopped sessions.
  Water, movement and pet totals come directly from the shared account
  projection, with its UTC date. Before the first snapshot, totals show a dash;
  offline rollover keeps the last confirmed day visible instead of inventing
  zeros. The browser requests a projection refresh on connection/day changes.
- Pet artwork lives in `public/assets/`. Pet identity, name and AI speech remain
  server-owned. Creation and reset use `ensure_pet` and `reset_pet`; reset retries
  reuse their request UUID.
- `account_commands` is an insert-only PowerSync table. Each immutable intent
  enters the normal durable upload queue. `pending_commands` stores transport
  status only; it is never a separate source of account totals. Accepted timer
  controls stay overlaid until the matching canonical revision downloads;
  wellness and pet actions remain pending until their canonical event IDs
  arrive. Rejected conflicts remain visible for the user to review.
- Timer controls can be queued offline after the first account snapshot. Their
  provisional state is labelled pending, and confirmed daily totals do not
  increase until sync. Pet creation, reset and AI replies require a connection.
- Each upload checks the current signed-in identity. Account-specific IndexedDB
  databases survive React remounts; sign-out warns about queued actions and then
  clears the account cache. No authentication or account state is shared with
  another signed-in user.

This app has **no service worker**: it does not guarantee a cold start or page
reload without the app assets cached. Browser storage can be cleared or evicted.

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

Vitest covers revision conflicts, offline command chains, checkpoint acknowledgements, upload contracts, retries, and
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
