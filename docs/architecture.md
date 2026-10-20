# React app and cloud pet

## Responsibilities

| Component | Owns |
| --- | --- |
| React web app | Browser UI and timestamp-driven timers, hosted as static assets on Vercel |
| PowerSync Web SDK | Per-account browser SQLite in IndexedDB, workers, watched queries, upload queue |
| Supabase Auth | User identity and refreshable access tokens |
| Supabase Data API | Owner-scoped timer and wellness uploads |
| `pet-ai` Edge Function | Authenticated pet commands, bounded OpenAI requests |
| Supabase Postgres | Shared data, pet leases, idempotency, reaction ordering |
| PowerSync Cloud | Postgres changes filtered by authenticated owner |
| Future badge | Its own local database, UI, and compatible uploads |

## Write and read paths

Timer sessions and wellness events are written locally. The PowerSync connector
uploads them to Supabase under the signed-in user's JWT.
Postgres RLS checks ownership; PowerSync separately filters downloads by
`owner_id = auth.user_id()`. RLS alone does not control PowerSync downloads.

Daily counts are a reactive, read-only projection of sessions and wellness
events. They are never uploaded as cached counters, so an empty cache cannot
overwrite another device's counts. The existing daily-summary table remains for
explicit hydration-reminder metadata and compatibility.

Pet actions are immutable local `pet_events` inserts. The connector sends their
identifier, session, event type, source device, and timestamp to `pet-ai`. It
acknowledges the PowerSync transaction only after the function returns success.
The function authenticates the user, creates or finds the event, acquires an
expiring lease, calls OpenAI, and commits the result. Clients do not write pet
results through the Data API.

Replies return to UI via the PowerSync stream. Repeating a completed event does
not call OpenAI again. The lease allows retry after a crashed request and prevents
concurrent workers from committing each other's results. Server sequence numbers
prevent a slower old response from overwriting a newer reaction.

`ensure_pet` is keyed by owner, so a new installation with an empty local cache
does not replace an existing pet. Explicit resets carry a stable request UUID and
replace the pet session identifier. Events queued for an earlier pet are rejected
without invoking inference.

## Offline and failure behavior

Cached timers, wellness actions, and pet display work offline. Pending reactions
show local waiting text. First pet creation and pet reset need a network
connection. The app can use its timer while pet setup or inference is unavailable.
The browser app starts from its local database without waiting for a network
connection. It has no service worker, so opening the site from scratch or
reloading while fully offline is not guaranteed. Sign-out clears the account's
database; switching identities serializes cleanup before opening another cache.

Browser pet events use `source_device = 'web'`. The additive database migration
and updated function must be deployed before those events can upload. The backend
retains `macos` and `ios` source values for historical data and existing clients,
and `badge` for future firmware integration.
See [web setup and rollout](../web/README.md).

Network, authentication refresh, database, and retryable provider failures retain
the upload transaction. Sync status exposes upload errors instead of silently
discarding data. Invalid model output is recorded as a failed reaction.

For this milestone, inference happens synchronously during pet-event upload. A
provider outage can therefore delay later uploads in that client's queue, though
local writes remain durable. Before wider deployment, separate durable event
acceptance from inference using a server worker and independent retries.

## Cloud inference

The OpenAI key exists only in Supabase secrets. The client cannot choose a model
or submit arbitrary prompts; the server maps allowed events and animal IDs to a
short reaction prompt. Requests use the Responses API with `store: false`, a
30-second timeout, and bounded output.

Initial names/biographies use a deterministic server template. The original
Cactus narrative generation and transcript model context are not carried over.
Reactions are generated in the cloud. Richer persistent personalities can be
added without changing the device sync contract.

## Badge milestone

The badge should use the same authenticated user identity, table shapes, event
names, and upload endpoint. `source_device = 'badge'` is accepted by the backend.
The badge does not need an OpenAI runtime or API key.

Remaining work before calling badge sync complete:

- Provision and refresh badge credentials.
- Connect the badge's PowerSync/SQLite transport to these streams.
- Test offline reconnect and simultaneous timer actions on physical devices.
- Deduplicate timer-completion events across devices.
- Define conflict behavior for concurrent hydration-reminder metadata changes.
- Keep supported TLS cipher suites in the firmware; Supabase is retiring older
  TLS 1.2 CBC suites starting November 2026.

The existing timer repository preserves the original app's conflict behavior.
Two devices starting or completing timers simultaneously still need explicit
product rules and tests in that milestone.
