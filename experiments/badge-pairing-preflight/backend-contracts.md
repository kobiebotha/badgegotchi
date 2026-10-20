# Badge pairing backend: proposed contracts and review packet

Prepared 2026-10-20. This is a proposed design and local test artifact, not an
implemented endpoint, migration, credential, or authorization to deploy. The
contracts are not ready for deployment: numeric rate limits and trusted ingress
IP handling are unresolved; schema, credential persistence, upload semantics and
the actual custom-token/service contract still need implementation and validation.
Copying this report into the repository does not change those evidence boundaries.

## Verified baseline and evidence boundaries

- Repository: `/Users/kobie/projects/powersync/skunkworks/badgegotchi`.
- Supabase target: `bfccerfayrfolisawokp`.
- PowerSync instance: `6ad76c8f2f27853eb0b0a128`, project
  `6ad76c8e02e1e50007a3552a`. Its `Production` label is recorded in the repository
  as an owner-confirmed development target; that record does not authorize this
  service-auth change or deployment.
- Existing service configuration has `client_auth.supabase: true`. Existing
  five edition-3 streams are owner-filtered, auto-subscribed, full-history streams.
- Main-agent read-only cloud checks reported source connected, active config v3,
  no replication errors and zero lag. Source counts: 2 sessions, 2 wellness
  events, 1 pet session, 9 pet events, 0 summaries. These counts are not a
  projection capacity guarantee and do not measure badge SQLite/oplog usage.
- Parallel host capacity checks reported that an ordinary-column five-table
  client projection schema exhausts the actual 256 KiB core arena at schema
  creation. A compact three-table trial (legacy metadata, JSON projection rows,
  durable commands) fits 11 projections and 32 queued commands plus a persisted
  first-transaction capture in a 94,208-byte DB, with 196,096-byte peak arena usage.
  After projection churn, the 65th command INSERT reproducibly segfaulted near
  the DB size cap. This is host-only evidence; the root cause remains unresolved.
  See `capacity-results.md`. Client schema representation remains undecided.
- During the main-agent device preflight, Supabase HTTPS certificate validation
  succeeded with AES128-GCM; the reported maximum individual cooperative step
  was 923 ms. PowerSync also passed with an additional Sectigo R46 root held in RAM.
  Wrong-hostname, missing-root and expired-certificate checks rejected correctly.
  Entropy remained unqualified. These results
  do not establish authenticated enrollment, streaming or successful product sync.
- There is no pairing/device gateway or schema. Existing session and wellness
  tables allow owner-scoped REST writes. Pet writes are service-role-only RPCs.
- Local service source is commit `8a0fdc806eb2dd8a0d4a96bcd98d0b0a25176a20`,
  `@powersync/service-sync-rules` 0.43.0. The deployed service build has not been
  matched to this revision.

Reproduce the local stream proof:

```sh
node experiments/badge-pairing-preflight/check-streams.mjs
```

Actual result: **23 checks passed**, Node v25.9.0, recorded in
`evidence/check-streams-results.txt`. The script uses the
built local compiler and SQLite bucket evaluator, intersects authorized request
buckets with evaluated source rows, and does not contact a service. It tests
issuer/scope separation, owner isolation, both forged client-parameter channels,
explicit subscription attempts, the slot filter, and independence from 1,000
extra full-history rows. It also verifies LIMIT and ORDER BY rejection.
JWT signature verification, database constraints, live service compatibility,
physical device memory, and badge checkpoint completion remain separate gates.

## Authentication boundaries

Use separate functions or equivalent explicit routing boundaries:

| Responsibility | Credential | Server authority |
| --- | --- | --- |
| Owner create/status/cancel/approve/list/rename/revoke | Existing Supabase user JWT, validated against Auth | Derive owner from validated user, never request body |
| Bootstrap claim | Strictly bounded ABC code + pending secret + candidate credential | Rendezvous only; cannot authorize any device |
| Pending poll | Pending-secret proof over verified TLS | Metadata for that exact pending claim |
| Enrollment acknowledgment | Approved candidate credential | Bind delivery to the activated exact device |
| Credential renewal, rotation, upload | Active opaque device credential | Resolve owner/device on server and check revocation |
| Public JWKS | None | Public verification keys only |

The owner function may retain platform `verify_jwt=true`. A device/bootstrap
function needs its own complete authentication and rate boundary if configured
with `verify_jwt=false`; disabling the existing `pet-ai` checks is not part of
this change. A publishable key is not a device identity. CORS is not authorization.

Preserve existing Supabase browser authentication. Device credentials must not
be copied Supabase refresh tokens, and PowerSync JWTs are download credentials,
not Supabase REST or `pet-ai` bearer tokens.

## Private schema and privilege contract

Create through a new Supabase migration generated with the installed CLI.
Use `private` tables with RLS enabled, no public/anon/authenticated privileges,
and no membership in the PowerSync publication. Explicitly revoke default
function EXECUTE from PUBLIC/anon/authenticated and grant only service_role.
Service-only `SECURITY INVOKER` RPCs match the existing pet RPC pattern.
Every RPC must still derive or verify the authenticated owner/device and enforce
field restrictions because service-role access bypasses client RLS.

| Proposed private table | Required data and constraints |
| --- | --- |
| `badge_pairing_sessions` | UUID, owner, keyed code digest, state, expires_at, approved_claim_id, version, timestamps. Unique active code digest; one active owner session or an explicit small owner cap. |
| `badge_pending_claims` | UUID, session, pending-secret digest, candidate-credential digest, verification identifier, state, expiry. Immutable digest bindings, unique pending digest, bounded claims per session. |
| `badge_devices` | UUID, owner, bounded name, registration state, paired/revoked/contact times. One registration for each approved claim. |
| `badge_credentials` | Digest, device, state (pending/active/retired/revoked), rotation request ID, expiry/version. No plaintext credential; explicit overlap during recovery. |
| `badge_rate_windows` | Scope, keyed subject, fixed time bucket, count. Atomic increments and bounded retention. |
| `badge_upload_receipts` | Owner, device, request_key, payload digest, acceptance result, accepted_at. Unique `(owner, device, request_key)`. |

Pairing digests must use domain-separated HMAC with a server-only key because
the ABC code has only about 19 bits of entropy. High-entropy credentials may be
hashed with a domain-separated digest/HMAC. Persist the HMAC key version for
rotation. Never place secrets or code bodies in URLs, logs, analytics, error
messages, replication, packages, or browser device-list responses.

An index predicate cannot depend on moving `now()`. Uniqueness should depend on
an explicit active state; allocation retires expired sessions transactionally
and retries RNG collisions. Use cryptographic unbiased symbol generation.
Store code digest only. If the creation response is lost, status can explain
that the code must be regenerated; never claim to reconstruct the code from its
digest. Regeneration atomically invalidates all old pending claims.

## Atomic enrollment lifecycle

1. Badge generates and durably stores independent 256-bit pending and candidate
   secrets before attempting claim. They live in private app-owned `/state`,
   not the USB-visible application folder. Never generate a replacement after
   an ambiguous response without an explicit enrollment reset.
2. Create a five-minute, twelve-symbol ABC session for the authenticated owner.
   Those values are proposed defaults. The code is a rendezvous identifier only.
3. Claim validates body size/alphabet/length and rate limits before lookup.
   Session and claim updates use a consistent locking order. Same pending
   secret and candidate credential returns the same claim; mismatched reuse
   rejects. Bound simultaneous claims per session (proposed maximum 3).
4. Return an immutable verification identifier derived from the exact claim and
   candidate binding. Both badge and browser show it. The owner must select and
   explicitly approve that exact claim; no auto-approval after a correct code.
5. Approval locks session/claim, verifies owner, expiry and expected state,
   creates exactly one device and active candidate credential, records the
   approved claim, retires the code, and rejects sibling claims atomically.
   Repeated approval of the same claim returns the same registration. Approval
   of another claim after the first success rejects.
6. Poll with pending proof returns only approved registration metadata. The
   badge already owns its candidate credential; the server never reconstructs
   it. A bounded recovery window for an approved enrollment is separate from
   the original code expiry. Poll does not itself mark enrollment delivered.
7. Badge proves the active candidate credential before acknowledgment. Duplicate
   acknowledgment returns the same result. Persist paired identity atomically
   before removing pending enrollment metadata on the badge.

Cancel, regenerate, expiry and approval share the same session lock so races
have one outcome. Define expiration using server time. Safe status responses
distinguish pending, approved, delivered, cancelled, expired and revoked without
revealing another owner's claims. A guessed code never bypasses owner approval.

## Rate and request limits

Before public deployment define numeric limits with operational monitoring for:
aggregate service, verified source IP, owner, active session/code, pending secret
and active device. Count unsuccessful attempts as well as successful ones.
Do not trust invented device IDs or arbitrary client-supplied forwarding headers.
The deployment must identify a trustworthy ingress IP source or enforce the IP
limit at a verified proxy. This is an outstanding deployment prerequisite.
No effective numeric thresholds or trusted-IP implementation have been selected
or tested. The protocol must not be described as production-ready until these
are concrete and adversarially verified. Counters must update atomically and remain effective across Edge Function
instances. Responses use retry-after for throttling and avoid indicating whether
an unmatched code exists. Bound JSON body size before buffering/parsing.

## Rotation and revocation

Current credential authorizes a stable rotation request and proposed new digest.
The badge persists old/new credentials and request ID before transmission. Server
keeps the old credential usable during a bounded pending/confirmed overlap. Only
proof of the new credential confirms rotation and permits retirement of the old
one. A lost response must leave a recoverable usable credential on both sides.

Device revoke invalidates active and pending credentials and pending enrollment
in one transaction. Upload and renewal check active-device state in the same
transaction as acceptance, including lost-response receipt retries. Already issued
PowerSync JWTs have a finite residual download window; remote erasure of an
offline badge is not promised. Web sign-out does not silently revoke devices.

## Proposed service-auth diff for review, not application

Target is the instance/project identified above. Proposed public route paths and
issuer are not currently deployed and must be tested before client integration.

```yaml
client_auth:
  supabase: true
  jwks_uri: https://bfccerfayrfolisawokp.supabase.co/functions/v1/badge-gateway/jwks
```

Local shape validation passed against the installed PowerSync CLI **0.10.2**
`@powersync/cli-schemas` **0.10.2** `service-config.json`. The test parsed the
existing service YAML read-only, merged the proposed `jwks_uri` into its
`client_auth` object in memory, and used Ajv to validate the full candidate:
`candidateValid: true`, `errors: null`. This validates the current local Cloud
config schema, not remote acceptance, JWKS reachability, signer correctness,
key refresh/rotation or the running instance's exact token behavior. No service
configuration was written or deployed. The inspected cache root was
`/Users/kobie/.npm/_npx/0334ccd2bc18f7b6/node_modules`.

Use a dedicated server-only asymmetric signing key (proposed ES256) and unique
`kid`. JWKS contains only public material. Proposed JWT contract:

- `sub`: resolved existing owner UUID.
- `iss`: exact `https://bfccerfayrfolisawokp.supabase.co/functions/v1/badge-gateway`.
- `aud`: exact accepted PowerSync instance audience, verified on target.
- `iat`, `exp`: server timestamps, proposed 300-second lifetime.
- `device_id`: resolved active device UUID.
- `badge_scope`: exact `v1`.

The local service KeyStore requires sub/iat/exp/aud, has 60-second clock
tolerance, and does not configure a JWT issuer check. Therefore stream guards
must explicitly constrain issuer as well as scope. Do not assert a five-minute
maximum revocation window until real token expiry and already-open stream tests
measure it; tolerance and service stream handling may extend the observed window.

Existing browser streams need this guard:

```sql
WHERE owner_id = auth.user_id()
  AND auth.parameter('iss') = 'https://bfccerfayrfolisawokp.supabase.co/auth/v1'
  AND auth.parameter('badge_scope') IS NULL
```

Badge projection streams need this guard:

```sql
WHERE owner_id = auth.user_id()
  AND auth.parameter('iss') = 'https://bfccerfayrfolisawokp.supabase.co/functions/v1/badge-gateway'
  AND auth.parameter('badge_scope') = 'v1'
  AND auth.parameter('device_id') IS NOT NULL
```

This intentionally excludes development tokens or other issuers lacking the
exact contract. Verify any existing dev-token workflow before rollout; do not
add an issuer-free fallback. The evaluator assumes JWT claims have already been
authenticated. It is not a proof that signing authorities cannot issue incorrect
claims; the badge signer must never issue browser-issuer tokens.

## Fixed-cardinality downloads

Use PostgreSQL-maintained projection tables, populated atomically with canonical
writes, preserving cloud history. Proposed initial shape:

- `badge_current_pet`: at most one row per owner, bounded text columns.
- `badge_current_session`: at most one canonical active/paused session per owner.
- `badge_current_summary`: at most one authoritative current-day row per owner.
- `badge_recent_activity`: at most eight rows per owner, fixed slots 0 through 7.

Require database uniqueness on owner for singleton tables, and `(owner_id,slot)`
with a non-null integer slot and `CHECK (slot >= 0 AND slot < 8)` for recent activity. Queries repeat the slot
condition defensively. The query condition alone does not enforce one row per
slot. Supabase client roles cannot write these tables. They contain no credential
material and are published explicitly after review. Full history remains in the
existing tables, and new writes prune/replace projections only.

The initial ceiling is 11 logical rows, not a proven 128 KiB database budget.
Measure worst-case encoded text, local queue, checkpoint, oplog, journal and
subscription turnover together. Every projection must update on changes from
the web writer too; lazy badge-only refresh would omit web changes.

The four source projection tables tested by the evaluator are a logical server
design, not an approved four-table ordinary-column client schema. The parallel
capacity results above require revisiting the client representation. Mapping or
aliasing these sources into a compact JSON client table is a possible next
experiment; that mapping, its ID namespace, schema behavior and update/delete
semantics have not been tested here. Do not infer that passing stream authorization
tests makes the client storage design ready.

Pinned core 0.5.4 supports `powersync_control('subscriptions', ...)` and
`start.include_defaults=false`; use those to request only the intended streams,
while retaining server guards against clients requesting every stream. Subscription
TTL defaults to one day; explicit TTL and eviction need physical storage tests.
Do not use LIMIT, ORDER BY, moving-time assumptions, or omitted client tables as
the bound. Full event counts cannot be derived from an eight-row window.

## Canonical conflicts, totals and legacy progress

Use a server per-owner lock and versioned session transitions for both badge and
web writers. Proposed policy is first accepted start wins; a concurrent start
returns an explicit conflict and does not silently stop or replace either timer.
Pause/resume/end carry a stable transition ID and expected session version.
Stale mutations reject; ended sessions cannot be resumed. Valid state transitions
set/clear all related timestamps/outcome consistently. Local optimistic state
needs visible conflict resolution and must preserve rejected pending work.

Completion reactions use the server-validated accepted transition identity
`(owner_id, timer_session_id, accepted_revision)`, with a uniqueness constraint.
An ended session is terminal, so a second completion cannot create another
accepted transition. Random pet-event UUIDs alone do not deduplicate two devices
completing one session.
There are no pause_break/resume_break pet enum types. Both clients must adopt
the transition contract before timer parity can be claimed.

Authoritative daily projections distinguish completed-focus count from ended
focus count (completed plus stopped), preserve UTC days and the 40/10-minute
phase rules, and start the next phase paused. Counts come from canonical records
or transactional rollups, not existing client-authored summary counters.

Retain the legacy snapshot as pre-pairing progress. Do not fabricate historical
event IDs/timestamps from aggregate counts. If a local timer and account timer
both exist, present an explicit continue/adopt decision without resetting either
silently. Unpair/account change quarantines old-owner pending writes and cached
data and offers export/discard policy before deletion.

## Atomic uploads and asynchronous pet processing

Capture one complete bounded local transaction and its stable request identity
before I/O. Distinguish the **total offline queue admission budget** from the
**per-upload transaction budget**. The compact capacity fixture demonstrated 32
queued command rows under one specific payload profile; that is a provisional
count ceiling, not an allowance for arbitrary 32-command payloads. Enforce a
separately measured total encoded-byte/database budget and safe reserve before
admission. The sibling C adapter's 16-entry/4-KiB request envelope is reference
implementation context only, not a selected gateway or device contract. Actual
per-transaction operation and byte limits remain undecided. Never split a
transaction or drop queued work to meet a transport bound. Server authenticates the active
device, derives owner, validates all table/field/transition contracts, writes the
whole transaction, inserts durable pet intentions, updates projections, and stores
the receipt atomically. No SQL transaction waits for HTTP/OpenAI.

An identical `(owner,device,key,payload_digest)` retry returns the same receipt.
Different payload under the same key rejects. Server validation failure or
conflict rolls back the entire request; no partial acceptance. Permanent errors
remain queued with visible resolution, and never masquerade as acceptance merely
because the HTTP status is 200. Preserve the distinction between backend acceptance,
local captured-range acknowledgment, core notification, service write checkpoint
and server echo. Later local writes survive earlier queue acknowledgment.

Pet inference runs in a real bounded retry worker after durable intent acceptance,
reusing existing claim/lease/finish logic. A background fire-and-forget invocation
alone is not a durable worker. AI outage must not hold wellness/session acceptance.

## Required implementation tests before deployment

1. SQL privilege/publication tests: client cannot read private tables, call service
   RPCs, author projections, or replace owner IDs; credentials are unpublished.
2. Multi-connection SQL race tests: simultaneous claims/approvals; cancel or
   regenerate versus approval; expiry boundary; same candidate duplicated.
3. Enrollment recovery: lost create response, lost claim/approval/poll/ack replies,
   restart using same persisted secrets, wrong pending proof, wrong active proof.
4. Auth isolation: owner A cannot manage B; badge B cannot upload A; revoked
   device cannot renew/upload; spoofed request identity does not affect resolution.
5. Limits: per-IP and global exhaustion, concurrent counter updates, unknown
   device IDs, body bound before parse, code alphabet and exact length.
6. Upload: lost accepted response, changed payload with same key, invalid final
   operation leaves no partial writes, later writes survive acknowledgment,
   revocation races, conflicts retain pending progress, OpenAI outage.
7. Projection SQL constraints and triggers: all mutation paths update projections;
   max sizes and row ceilings; UTC rollover; history remains untouched; concurrent
   timer starts and duplicate completion intents converge under documented policy.
8. Actual target: both Supabase browser JWT and badge JWT accepted as intended;
   wrong signature/audience/issuer/scope rejected or yield no data; old key rotation;
   JWT expiry and existing-stream revocation window measured.
9. Badge gate: verified TLS/clock/entropy, interruption-safe private credentials,
   small real checkpoint, web-to-badge and badge-to-web round trip, capacity,
   responsive Home, and preservation before any release claim.

Existing harnesses are `supabase/functions/pet-ai/handler_test.ts`,
`supabase/tests/pet_ai.sql`, `supabase/tests/rls_event_trigger.sql`, and the sibling
real-core host adapter tests. Current rollback-only SQL scripts are useful for
functional assertions but cannot establish multi-connection concurrency by themselves.

## Primary references

- https://docs.powersync.com/configuration/auth/overview
- https://docs.powersync.com/sync/streams/parameters
- https://supabase.com/docs/guides/functions/auth
- https://supabase.com/changelog/cbc-tls-ciphers-deprecated

Local source anchors: service `packages/service-core/src/auth/KeyStore.ts`,
`packages/service-core/src/util/config/compound-config-collector.ts`,
`packages/sync-rules/src/compiler/parser.ts`; pinned core
`crates/core/src/sync/interface.rs` and `crates/core/src/sync/subscriptions.rs`.
