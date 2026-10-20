# Installable Badgegotchi app

The `0.1.0-alpha.3` candidate adds one-time A/B/C account pairing, automatic
reconnect, durable water/movement uploads to Supabase, and a bounded PowerSync
projection to the ordinary Badgeware app. Its 40-minute focus / 10-minute break
timer remains local. The implementation is present; cloud activation and live
device pairing/sync qualification are pending. The qualified alpha.2 installer
release remains unchanged until a candidate is explicitly staged and published.

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

C records hydration and Up records movement in a durable queue, bounded to 16
events and uploaded in batches of at most eight. Request IDs and receipts make
retrying an accepted batch safe. An event that cannot be queued is refused with
a visible message. Account summary dates use UTC. The `badge_projection` stream
contains at most three current records (`pet`, `timer`, `summary`), with a 1536-byte
payload limit each. It does not replicate account event history. The badge shows
account pet name/speech and daily wellness totals with the bundled capybara art.

The downloaded account timer projection is kept separate from the local timer.
Badge timer controls, focus completions, pet interactions, and local acknowledgements
are not uploaded; the badge makes no pet-state or AI writes. Down opens an info
view with retained before-pairing counts, daily account summary, and queue count.
Local lifetime totals are distinct from account daily totals. `SYNCED` requires
an empty upload queue and a PowerSync checkpoint covering accepted uploads.

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
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s badge/tests -v
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
The alpha.1 to alpha.2 update has device qualification; alpha.3 does not yet.
Run the tool without `--install` first, then use a new host backup path:

```sh
python3 badge/tools/update.py OLD.zip NEW.zip /Volumes/<badge>
python3 badge/tools/update.py OLD.zip NEW.zip /Volumes/<badge> --backup /path/to/new-backup --install
```

Use USB disk mode with no other app-copy process running. The directory swap is
not power-failure atomic; retain both backups. The tool never opens `/state`.
On first launch, alpha.3 migrates recognized schema 1/2 data additively to schema
3, retaining the timer/counters and a separate legacy snapshot. It does not
manufacture account events from historical local counts. Older app versions do
not understand schema 3; downgrading just the app is unsupported.

## Application lifecycle and storage

The native module loads once from the app's FAT directory. The bounded SQLite
database lives in owner-marked `/state/badgegotchi` on the existing LittleFS
mount. Pairing identity and queued events live in a separate owner-marked
`/state/badgegotchi-pairing` directory. Private JSON writes are bounded, flushed,
synchronized, and renamed before success is reported. Nothing private is stored
in the app package. No raw flash operations or second LittleFS mount are used.

The local timer uses monotonic time while open and the badge RTC for time away.
Unset or backward-moving clocks pause restoration; completion while away is
recorded once on reopening. Saves occur on actions, completion, minute checkpoints,
and normal Home exit. The Home interrupt only requests exit; the foreground loop
finishes SQL, saves, closes network/database handles, and waits for Home release
before resetting to the original launcher. SQL never runs in the interrupt.

SQLite uses one connection, DELETE journaling, full synchronization, an eight-page
cache, a 128 KiB ceiling, and a free-space reserve. Startup validates ownership,
filenames, schema, integrity, and snapshot shape. Nonempty leftover journals are
preserved and stop startup because missing truncate support prevents qualifying
general recovery. Errors and unsupported data never trigger automatic deletion,
repair, or reinitialization. Sync frames are limited to 8192 bytes; the projection
and page guard keep this workload away from the native allocator's known limits.

The app's secret adapter hashes an application/version prefix with 1536 fresh
`os.urandom` bytes for each draw. This relies on the inspected stock RP2350/SDK
RNG path; hashing does not establish or create a quantified amount of entropy.
TLS still uses the platform's Mbed TLS RNG path. See the
[source and assumptions review](../experiments/badge-pairing-preflight/entropy-review.md).
SQLite randomness also uses the platform RNG. The native callback boundary
translates Python exceptions to SQLite errors. The normal watchdog remains active.

## Qualification

Host tests exercise pairing persistence and approval, retry/idempotency behavior,
revocation, bounded queue/projection handling, retained legacy data, timer and
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

The alpha.3 device update, full browser-to-badge pairing, authenticated uploads,
PowerSync checkpoint convergence, restart/reconnect, and revocation still require
live qualification after cloud activation. Power-loss recovery, indefinite
operation, and fixed-arena exhaustion remain unqualified. No cloud deployment,
web installer publication, or live-sync success is asserted by this candidate.
