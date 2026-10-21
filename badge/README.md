# Installable Badgegotchi app

The `0.1.0-alpha.8` development candidate reduces projection data and batches
download writes while retaining the same account totals, timer, and pet used
by the web app. Both clients queue
immutable commands; Supabase applies them atomically and PowerSync downloads the
canonical state. Alpha.5 qualification and rollout status are recorded in the
[shared-state handoff](../docs/handoffs/badge-pairing-powersync.md). Alpha.4's
pair-once wellness flow was previously verified on the device.

Supported runtime: the measured Pimoroni Tufty 2350, MicroPython 1.29.0,
`bw-1.29.0-gc` dated 2026-09-22 (GNU 13.3.1 MinSizeRel), `_mpy=7942`, softfp.
The app checks that exact runtime and its bundled native module hash before
loading native code. Supporting another Badgeware build requires qualification.
No firmware change is required or included.

## Pairing and account data

After cloud activation, sign in to the web app and choose **Pair a badge**.
Enter its short-lived 12-symbol A/B/C code on the unpaired badge, releasing each
button between symbols; Up erases. The badge then displays a verification ID.
Approve the exact matching claim in the web app. The code alone does not approve
a claim. Later launches use the saved device credential and reconnect without
re-entering a code. Pending enrollment survives interrupted network requests.

The signed-in web app lists and revokes devices. Last contact is historical,
not an online indicator, and web sign-out does not revoke a badge. Revocation
stops future badge token issuance and uploads; an already-issued short-lived
PowerSync token can remain valid until it expires. General account switching
and a user-facing reset/re-pair flow are not implemented in this candidate.

A pets the synced companion, B controls the shared timer, C logs water, and Up
logs movement. Down opens account details, where B stops the timer. Home closes
the app without pausing the account timer. Completion prepares the opposite
phase paused; stopping prepares the same phase paused. The next B resumes it.

All totals come from the latest synced daily account summary, using UTC day
boundaries. The badge shows values without an account/date caption and only
shows pending-action text while work is queued.
Focus and Break count ended sessions, including stopped sessions. Pets counts
pet presses. The synced animal selects matching artwork from the same 30 assets
used by the web app. Name and speech also come from the account.

A durable 16-command queue retains offline actions. Pending timer controls are
provisional; totals remain confirmed values until sync. Owner-serialized timer
revisions reject conflicting commands. Immutable command receipts prevent
retries from recording duplicate events or completing a phase twice. AI reactions
are queued independently and retried by a server worker; they do not block
acceptance of timer or wellness actions. The old wellness queue drains existing
accepted work through its original endpoint.

The badge explicitly requests only `badge_projection_compact`, with at most three
records (`pet`, `timer`, `summary`) and a 1536-byte payload limit each. A separate
owner/issuer-guarded browser stream returns the same projection. `SYNCED` requires
empty upload queues and a PowerSync checkpoint covering accepted commands.

The app uses Badgeware's existing managed Wi-Fi lifecycle and configured access
point with bounded retry delays. It does not create a second Wi-Fi manager or
rewrite credentials. HTTPS verifies hostname and CA trust. The bundled public
Sectigo Root R46 supplements the runtime's installed Google Trust Services roots;
its provenance and SHA-256 are in
[`THIRD_PARTY_NOTICES.txt`](app/badgegotchi/THIRD_PARTY_NOTICES.txt).

## Build and install

The native build uses the pinned sources and toolchains from the preceding
[feasibility experiment](../experiments/badgeware-native/README.md). It does not
flash a device. It generates `native/module.json` and the matching Python
identity file, identifying the actual native bytes packaged.

```sh
# From the badgegotchi repository root, after final source review:
sh badge/native/build.sh
# Run focused Python checks; do not run the legacy full-capacity native stress suite.
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s badge/tests -p test_state.py -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s badge/tests -p test_packaging.py -v
python3 badge/tools/package.py
```

The builder uses an explicit source allowlist, checks the native header and
digest, and generates a per-file inventory. It emits a deterministic ZIP in
`badge/dist/` containing only `apps/badgegotchi/...`. Identical inputs produce
identical bytes. Device data, toolchains, private keys, credentials, and UF2
images are excluded. This candidate includes the seven pairing/sync client
modules and public CA certificate in addition to the existing app assets.

Building a ZIP does not stage or deploy it. `--stage-web` separately writes a
content-addressed release and updates the local installer manifest only after
all referenced files exist. Do not stage this candidate before cloud activation
and the required qualification; Vercel deployment is a separate approved action.

For a qualified first install, double-tap rear Reset to enter Badgeware's USB
disk mode. Extract the ZIP and copy `apps/badgegotchi` into the existing `apps`
folder. Keep all other disk contents, safely eject, press Reset, and select
`badgegotchi` in the launcher. BOOTSEL is not used. The bounded host installer
can inspect the operation before copying:

```sh
python3 badge/tools/install.py /path/to/badgegotchi-<release>.zip /Volumes/<badge>
python3 badge/tools/install.py /path/to/badgegotchi-<release>.zip /Volumes/<badge> --install
```

Host and browser first-install flows refuse an existing `badgegotchi` folder.
Automatic uninstall is not implemented. The web route `/install` offers its
staged ZIP and optional Chromium directory picker; pairing is a separate
signed-in flow. See [installer documentation](../docs/badge-installer.md).
The candidate requires the configured Supabase badge gateway, its migration
and signing configuration, and the matching PowerSync authentication/stream
configuration to be activated before pairing can work.

`badge/tools/update.py` verifies every installed app file against the old ZIP,
backs it up outside the badge, stages and verifies the replacement, then swaps
only the app directory. It retains the previous directory on the badge too.
The alpha.2, alpha.3 and alpha.4 checked updates have device verification with
backups and preservation checks. See the versioned evidence below.
Run the tool without `--install` first, then use a new host backup path:

```sh
python3 badge/tools/update.py OLD.zip NEW.zip /Volumes/<badge>
python3 badge/tools/update.py OLD.zip NEW.zip /Volumes/<badge> --backup /path/to/new-backup --install
```

Use USB disk mode with no other app-copy process running. The directory swap is
not power-failure atomic; retain both backups. The tool never opens `/state`.
On first launch, alpha.5 transactionally migrates recognized schemas 1–3 to
schema 4. The owner authorized discarding old badge-only progress in this dev
environment. Only `current` and `legacy` progress rows are deleted; pairing,
account binding, projection, and checkpoints remain. No history is imported or
removed from the account. Downgrading just the app is unsupported.

The current sync optimization candidate upgrades schemas 1–4 to schema 5. Its
synced table stores only `payload`; the short row id (`pet`, `timer`, `summary`)
also identifies the kind. Existing `owner:kind` rows remain readable offline
until a covering checkpoint replaces them. The account binding, private command
queue, and native checkpoints are preserved. See [sync optimization and rollout](../docs/badge-sync-optimization.md)
before packaging or installing this candidate.

## Application lifecycle and storage

The native module loads once from the app's FAT directory. The bounded SQLite
database lives in owner-marked `/state/badgegotchi` on the existing LittleFS
mount. Pairing identity and queued events live in a separate owner-marked
`/state/badgegotchi-pairing` directory. Private JSON writes are bounded, flushed,
synchronized, and renamed before success is reported. Nothing private is stored
in the app package. No raw flash operations or second LittleFS mount are used.

The timer derives remaining time from synced UTC session timestamps, overlaid
with durable pending commands when offline. It has no separately saved local
snapshot. The Home interrupt only requests exit; the foreground loop finishes
SQL, closes network/database handles, and waits for Home release before returning
to the original launcher. SQL never runs in the interrupt.

SQLite uses one connection, DELETE journaling, full synchronization, an eight-page
cache, a 128 KiB ceiling, and a free-space reserve. Startup validates ownership,
filenames, schema, integrity, and bounded projection shape. Nonempty leftover journals are
preserved and stop startup because missing truncate support prevents qualifying
general recovery. Errors and unsupported data never trigger automatic deletion,
repair, or reinitialization. Sync frames are limited to 8192 bytes; the projection
and page guard keep this workload away from the native allocator's known limits.

Downloads retain at most six operations and 8192 bytes in RAM before a single
durable SQLite commit. The buffer flushes before checkpoint/control records,
on network idle, or after 100 ms of foreground elapsed time. SQL transactions
never span network reads. Every operation still reaches the PowerSync core in
order; incomplete downloads do not become visible before a valid checkpoint.

The app's secret adapter hashes an application/version prefix with 1536 fresh
`os.urandom` bytes for each draw. This relies on the inspected stock RP2350/SDK
RNG path; hashing does not establish or create a quantified amount of entropy.
TLS still uses the platform's Mbed TLS RNG path. See the
[source and assumptions review](../experiments/badge-pairing-preflight/entropy-review.md).
SQLite randomness also uses the platform RNG. The native callback boundary
translates Python exceptions to SQLite errors. The normal watchdog remains active.

## Qualification

Host tests exercise pairing persistence and approval, retry/idempotency behavior,
revocation, bounded queue/projection handling, legacy progress removal, timer and
button handling, storage ownership and preservation, package integrity, and
checked app updates. Native host fixtures use POSIX storage and are not device
evidence. The native core's fixed 256 KiB arena is not qualified for arbitrary
queries or exhaustion recovery; do not run native stress tests on this badge.

Prior device installation, native import, rendering, persistence, and app
fingerprints are recorded in the [initial qualification](evidence/qualification.md)
and [timer update qualification](evidence/qualification-alpha2.md).
The [alpha.3 bounded device checks](evidence/qualification-alpha3.md) verified
private-file recovery, the RNG adapter, verified TLS with unauthenticated 404/401
responses, and migration of a live-database copy with a synthetic three-row
real-core checkpoint. The live database hash stayed unchanged. These checks,
the [reconnect source audit](evidence/network-reconnect-alpha3.md), and
[network preflight](../experiments/badge-pairing-preflight/) do not establish
completion of the live account flow.

The approved development gateway, guarded streams and badge JWT trust are
activated. Physical A/B/C pairing and matching-ID approval succeeded. Alpha.4
fixes the request format and streams large history batches incrementally; its
source completed an authenticated PowerSync checkpoint on the badge. The checked
alpha.4 update is installed with the saved pairing unchanged. Two physical water
presses reached Supabase and the web app exactly once each; one approved web
movement reached the badge. Home/reopen reached SYNCED without another code.
Final checks found a healthy 40 KiB DB, fully applied checkpoint, empty queues,
and unchanged legacy progress. See [activation status](../docs/badge-pairing-activation.md)
and [alpha.4 evidence](evidence/sync-fix-alpha4.json) for the exact completed checks.
Live revocation timing, power-loss recovery, indefinite operation, and fixed-arena
exhaustion remain unqualified. The public installer still serves alpha.2.
