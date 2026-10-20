# Alpha.3 pairing candidate qualification

2026-10-20. This records local implementation and bounded tests on the unchanged
Tufty 2350 Badgeware runtime. It is not evidence of live authenticated pairing,
a deployed gateway, a firmware change, or an installed alpha.3 release.

## Preserved runtime and data

Runtime remains MicroPython 1.29.0, Badgeware bw-1.29.0-gc dated 2026-09-22,
Tufty 2350 / RP2350, MPY 7942. Native module is unchanged: SQLite 3.54.1,
PowerSync 0.5.4/cratesio; SHA-256
802223bc6d2f7daea4c04b975bf2c6208068ef968891557e726bd485d3efafa8.
The live app remains alpha.2. All device tests used disposable owned directories,
removed after success. Existing app files, launcher, Wi-Fi settings and credentials
were not replaced. Hash equality confirmed the live SQLite database unchanged.

## Device observations

- Private pairing writes: persisted pending state, simulated an incomplete
  `.next` replacement, recovered the previous authoritative record, saved paired
  state, and read it back. Disposable directory was cleaned. This tests behavior
  around publication, not physical power cuts at every filesystem instruction.
- New credential RNG adapter: two fresh 32-byte outputs, SHA-256 conditioning of
  fresh 1,536-byte platform draws, completed in 4 ms combined. No random bytes were
  logged or retained. This is latency/API evidence, not an entropy estimate;
  see [source and trust assumptions](../../experiments/badge-pairing-preflight/entropy-review.md).
- New stepped HTTPS adapter: verified TLS, bounded DNS/HTTP, public POST only.
  Supabase gateway URL returned 404 (not deployed), 65 response bytes, maximum
  single step 771 ms. PowerSync `/sync/stream` returned 401 (no token supplied),
  113 response bytes, maximum single step 285 ms. Temporary public Sectigo root
  was removed. Neither request contained account credentials or a user action.
- New v3 Store migrated a byte-verified copy of the live v2 DB in 2,775 ms.
  Current snapshot and immutable legacy snapshot matched. Owner/device binding
  was idempotent. A synthetic real-core checkpoint published 3 bounded projection
  rows; DB 44 x1024-byte pages, integrity_check=ok, ps_crud=0. Native stats reported
  102,336 bytes used and 151,104 high-water (256 KiB arena). Close/reopen preserved
  snapshot, legacy, identity and projection. Live source DB hash stayed equal.
  Synthetic checkpoint identifiers exceeded 2^53 and remained exact.

The first HTTP diagnostic attempt failed in its host-injected module loader
before opening a network connection or creating files. MicroPython cannot create
module instances that way; a holder plus exec namespace corrected the test loader.
The application itself uses ordinary imports and did not need that workaround.

## Local automated checks

- 88 badge tests: storage migration, actual pinned core, supervisor checkpoint
 barriers, pairing lifecycle/replay, durable queue receipts, HTTP fragments,
 account boundaries, Home cleanup, timer behavior, entropy adapter, packaging.
- 142 web unit tests, TypeScript, production build, 6 development Chrome pairing
 tests and 7 production Chrome tests (pairing plus existing offline dashboard).
- 30 Deno gateway/pet-ai tests, type checks and lint.
- Real PostgreSQL/WASM migration and lifecycle/atomic-receipt assertions via PGlite.
- 17 checks compile/evaluate the actual scoped PowerSync config. CLI validation
 passed with expected missing `public.badge_projection` warnings before migration.

Tests use bounded workloads. The known-crashing full-capacity native CRUD stress
modes were not rerun. Badge uploads use a separate private durable command queue;
the SQL database is download-only except its local snapshots, with no SQL CRUD
outbox. Application guards stop sync before the database's FULL boundary.
This avoids the observed CRUD exhaustion path; it does not repair the upstream
native full-capacity fault or certify arbitrary queries.

## Remaining release checks

Review and authorize the exact Supabase/PowerSync activation first. Then verify
real owner authentication, physical A/B/C input and matching-ID approval, enrollment
reply loss/reopen, token refresh, revocation, badge-to-web wellness and web-to-badge
projection updates through actual PowerSync checkpoints, and Home cancellation
with the combined live workload. Reconnect behavior relies on the existing
[launcher network manager](network-reconnect-alpha3.md); forced radio loss during
the final app has not been tested yet. Timer commands remain explicitly local;
shared timer CAS, badge pet AI intentions and credential rotation are not part
of this candidate. No Vercel deployment or git push was performed.
