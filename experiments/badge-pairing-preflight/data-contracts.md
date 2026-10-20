# Badge pairing preflight: shared data, conflicts, and legacy migration

Prepared 2026-10-20 from the existing checkout. This is a proposed implementation
contract, not implemented behavior, a service-config change, or deployment approval.
Read alongside `capacity-results.md`; the ordinary per-column schema does not fit
the currently configured native arena in the tested host creation path.

## Canonical records and metrics

- Keep account activity in canonical `sessions` and `wellness_events`. Every new
  action receives a UUID once, before durable local enqueue; retries reuse it.
- Hydration/movement are append-only intentions. The gateway derives owner and
  source device from authentication; caller owner/device identity never grants
  authority. Validate lengths, enum values, durations, timestamp range, and UTC
  day keys. Do not silently repair malformed input into a different action.
- Keep `pet_sessions` and pet reaction results server-owned. Badge pet requests
  carry the current pet-session identity. A reset makes old pet intentions stale;
  it must not erase the independently valid wellness record.
- Keep 2400-second focus and 600-second break phases. Phase completion leaves
  the next phase awaiting B. Home retains elapsed badge-clock behavior; there is
  no background execution while the launcher/another app owns the VM.
- Publish authoritative server-maintained daily projection counts with separate
  `completed_focus_count`, `stopped_focus_count`, completed/stopped break counts,
  hydration, movement, last hydration, and projection revision. Existing web
  `ended_focus_count` remains completed+stopped unless its UI is deliberately
  relabeled. Historical alpha `focus_count` means completed focus only.
- A bounded recent activity list is display history, never the source of daily
  totals. Suggested projection is one current pet, one current timer, one current
  day's totals, and eight fixed recent-activity slots with explicit byte limits.
  Keep full history in the backend. Update projections in the same authoritative
  DB transaction as accepted canonical activity mutations.

## Timer conflict policy

Use the same command gateway for web and badge timer writes. Existing REST PATCH
cannot safely coexist as an unrestricted bypass after this policy is enabled.
Commands include `command_id`, `session_id`, `expected_revision`, transition,
observed/occurred time, and optional predecessor command identity for a locally
queued chain. The server owns the monotonic session revision and active-session
selection; use a per-owner lock plus a database invariant for at most one active
or paused canonical timer.

- First accepted start wins. An offline start is provisional until accepted.
  Another concurrent start becomes a visible conflict; preserve its intention
  without making a second canonical active row or silently stopping the winner.
- Deliberate replacement names the expected current session and revision. End the
  specified current session and create the replacement atomically. If they no
  longer match, require a new explicit choice using current canonical state.
- Pause/resume/end require the expected revision and valid source state. Stale
  transitions are conflicts, not last-write-wins patches. An ended session is
  terminal; a stale resume cannot resurrect it or leave terminal fields attached
  to an active state. Validate a complete canonical state shape on every change.
- Persist deduplication keyed by owner+command id and immutable payload digest.
  Same id+same payload returns the original decision; changed payload is rejected.
- Completion reaction identity is the canonical accepted timer transition
  `(owner_id, timer_session_id, accepted_revision)`, with a uniqueness constraint.
  Generate its pet intention server-side. Two device observations of the same
  completion produce one transition/reaction. Do not infer timer identity from
  the current `pet_session_id`. Break pause/resume emits no invented pet enum.
- Reset must record a tombstone/epoch boundary. Old offline creates/updates for
  a reset activity generation must receive a terminal conflict, not resurrect
  deleted history through REST upsert. An explicit recovery/import can be separate.

## Atomic upload acceptance and visible resolution

Capture one bounded local transaction durably with owner/device generation,
stable transaction id, exact queue range, and payload digest before sending.
Accept and decide the whole captured batch inside one DB transaction. Record a
receipt keyed by `(owner_id, device_id, transaction_id)` plus payload digest;
replies lost after commit are safely recoverable. Do not hold SQLite transactions
open during HTTP. Remove only the accepted captured range; later writes remain.

Distinguish transport/auth rejection from durable domain conflict. A domain
conflict may be acknowledged only when its original intention and decision are
retained in a durable visible resolution record, not silently dropped. Otherwise
leave it in a quarantined local queue awaiting explicit resolution. Acknowledge
neither unauthenticated data nor ambiguous/partial acceptance. Keep backend
acceptance, local queue removal, core upload notification, service write
checkpoint, and server echo as separate facts in state and tests.

Accept pet intentions durably without waiting for inference. A worker with real
retries reuses the existing pet lease/idempotency logic. Do not use successful
HTTP, enrollment, or gateway acceptance as the meaning of 'Synced'; require a
completed real PowerSync checkpoint.

## Legacy and identity migration

- First back up/read-verify the app-owned DB and qualify migration on a disposable
  copy using the unchanged runtime. Require known owner marker/schema/integrity;
  retain unknown files, failed databases, and nonempty journals unchanged.
- Proposed v3 retains the complete original v2 snapshot in an immutable local-only
  legacy record, with migration provenance and schema version. Preserve the
  original values and counter meanings visibly as 'Before pairing'. Aggregates
  have no event ids/times; never manufacture historical events or assign them to
  a cloud day.
- Keep the current local timer running under existing offline behavior until a
  pairing adoption choice is committed. Pairing with an account timer asks the
  user to use the account timer or explicitly replace it with the saved badge
  remainder. With no account timer, offer 'Continue saved timer' or retain it as
  local progress. Do not silently reset either timer.
- Adoption creates a new canonical timer starting at adoption time with the
  explicitly accepted remaining balance. Restore trusted elapsed local time once
  before taking the balance; round milliseconds consistently (ceil to seconds).
  Retain the original snapshot and adoption record. Do not invent a historical
  start time or credit legacy activity to daily totals. Apply ordinary expected
  active-session/revision rules to adoption so a concurrent web start conflicts.
- Bind all paired state, captures, credential generations, and pending writes to
  owner and device. Local unpair/account switch quarantines old-owner data; it
  never relabels old writes to the new owner. Provide export/discard resolution
  before deleting unsynced work. Web sign-out does not implicitly revoke badges.
- Credentials live only in explicitly allowlisted app-owned private `/state`
  files. Pending enrollment secret and candidate credential are independent
  256-bit values persisted before claim. Use generation/checksum and a qualified
  recoverable write protocol; do not assume truncation or rename is power-safe.
  Rotation retains the only working generation until replacement is confirmed.
- Migration must deliberately replace the current 'ps_crud must be empty' check
  with owner-bound queue validation and account-isolation guards. A generic
  remove/reset of unexpected outbox entries is not acceptable.

## Concrete inspected hazards

All references relative to `/Users/kobie/projects/powersync/skunkworks/badgegotchi`.

- `web/src/domain/repository.ts:94`: local transactions only terminate active rows
  visible to that device. `domain/queries.ts:1` chooses latest started and hides
  multiple active rows.
- `repository.ts:141`: resume writes three fields only. `lib/connector.ts:129`
  upserts and `:135` PATCHes without expected revision. Base SQL `:3-17` has no
  active-owner uniqueness or cross-field terminal-state invariant.
- `repository.ts:278,317`: completion pet intentions have random UUIDs and no timer
  session identity. Current pet event idempotency therefore cannot deduplicate
  two distinct device observations of one timer completion.
- `lib/connector.ts:85-93`: CRUD entries upload sequentially, with completion only
  after all requests, so server partial success followed by retry is possible.
- `supabase/functions/pet-ai/handler.ts:111` validates through `/auth/v1/user`;
  custom badge credentials are not accepted. `:210-259` waits for inference and
  returns 503 on an AI outage; this blocks the current sequential upload queue.
- `repository.ts:252`: reset deletes without tombstones, allowing later offline
  upserts to restore deleted activity.
- `domain/queries.ts:28`: daily counts derive from all raw rows. Stored daily
  counters are not a server-maintained authoritative rollup.
- `powersync/sync-config.yaml:6`: all five streams automatically subscribe full
  owner history; none is byte/row bounded or scoped by trusted badge identity.
- `badge/app/badgegotchi/badgegotchi_storage.py:221`: only owner marker, database,
  and journal are allowed. `:226` refuses any nonempty journal; `:249` permits
  versions 1/2 only; `:288` refuses any CRUD queue. `:143` cannot shrink files.
- `badge/native/module.c:6,69`: native arena 256KiB, max 32 returned rows. The host
  capacity fixture found an additional schema-memory blocker; see companion file.

## Verification already performed

Read-only pre-alpha2 backup: 33,792 bytes, 33 x 1024-byte pages, zero free pages,
schema v1, `integrity_check=ok`, no `ps_crud`; retained 2,243,961ms, six pets, one
water, one stretch, zero completed focus. This historical backup is not the
current device database or proof of current free space.

50 existing badge tests passed, including pinned real-core host tests. 34 web
domain/connector/account-lifetime tests passed with `--configLoader runner
--no-cache` after the default runner was sandbox-blocked writing `.vite-temp`.
No source files, actual backup, device, cloud, or service config were changed.
