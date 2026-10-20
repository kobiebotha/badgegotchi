# Installable Badgegotchi app

The local alpha is an ordinary Badgeware app, with a 40-minute focus timer,
10-minute breaks, Mochi artwork, and saved focus/water/stretch/pet totals.
SQLite and the real PowerSync 0.5.4 extension store one local-only state row.
Pairing, live cloud replication, and AI are not connected in this release.

Supported runtime: the measured Pimoroni Tufty 2350, MicroPython 1.29.0,
`bw-1.29.0-gc` dated 2026-09-22 (GNU 13.3.1 MinSizeRel), `_mpy=7942`, softfp.
The app checks that exact runtime and its bundled native module hash before
loading native code. Supporting another Badgeware build requires qualification.

## Build and install

The native build uses the pinned local sources and toolchains from the preceding
[feasibility experiment](../experiments/badgeware-native/README.md). It does not
flash a device. The build generates `native/module.json` and the matching Python
identity file; both identify the actual native bytes packaged.

```sh
# From badgegotchi repository root:
sh badge/native/build.sh
python3 -m unittest discover -s badge/tests -v
python3 badge/tools/package.py
# Also stage a matching static release for the web installer:
python3 badge/tools/package.py --stage-web
```

The package builder uses an explicit source allowlist, checks the native header
and digest, and generates a per-file inventory. It emits a deterministic ZIP in
`badge/dist/` with only `apps/badgegotchi/...`. Rebuilding with identical inputs
produces identical bytes. No device data, toolchain files, credentials, or UF2
images enter the package. Static web artifacts are content-addressed; the
manifest changes only after all referenced files have been written.

Double-tap rear Reset to enter Badgeware's USB disk mode. Extract the ZIP and
copy its `apps/badgegotchi` folder into the disk's existing `apps` folder.
Safely eject and press Reset. Select `badgegotchi` in the existing launcher.
Keep all other disk contents. BOOTSEL is not used for app installation.

Alternatively, inspect then copy with the bounded host installer:

```sh
python3 badge/tools/install.py /path/to/badgegotchi-<release>.zip /Volumes/<badge>
python3 badge/tools/install.py /path/to/badgegotchi-<release>.zip /Volumes/<badge> --install
```

The first-install host and browser flows refuse an existing `badgegotchi` folder.
Automatic uninstall is not implemented. The web route `/install` offers
the same ZIP and an optional Chromium directory picker; see
[installer documentation](../docs/badge-installer.md). Nothing is deployed by
these commands.

For the qualified alpha.1 to alpha.2 update, `badge/tools/update.py` checks that
every installed app file exactly matches the old ZIP, backs it up outside the
badge, stages and verifies the new ZIP, then swaps only the app directory. It
retains the previous directory on the badge too. Run it first without `--install`
to inspect the proposed versions, then with a new host backup path:

```sh
python3 badge/tools/update.py OLD.zip NEW.zip /Volumes/<badge>
python3 badge/tools/update.py OLD.zip NEW.zip /Volumes/<badge> --backup /path/to/new-backup --install
```

Use USB disk mode with no other app-copy process running. The directory swap is
not power-failure atomic; retain both backups. This tool never opens `/state`.
On its first launch, alpha.2 adds a clock field to the recognized v1 snapshot in
one SQLite transaction and preserves timer progress and all counters. The old
app does not understand the new schema, so downgrading just the app is unsupported.

## Application lifecycle and storage

The app loads its native module once from its own FAT app directory. Saved data
lives separately in owner-marked `/state/badgegotchi` on the existing LittleFS
mount. It uses no raw flash operations and mounts no second LittleFS instance.

The timer uses monotonic elapsed time while open and the badge RTC to account
for time away after Home. Unset or backward-moving clocks pause restoration
safely; completion while away is recorded once on reopening. The app saves
on button actions, phase completion, minute checkpoints, and normal Home exit.
The Home interrupt only requests exit; the foreground loop finishes SQL, saves
a running or paused snapshot, closes all file handles, waits for Home release, then resets
to the original launcher. SQL is never called from the interrupt handler.

Storage is one connection, DELETE journaling, full file synchronization, an
eight-page cache, a 128 KiB database ceiling, and a reserved amount of free
LittleFS space. It verifies the owner marker, recognized filenames, schema
version, quick integrity check, and snapshot shape. Nonempty leftover journals
are preserved and cause startup to stop, because this firmware's missing
truncate API prevents qualifying general journal recovery. Neither an error nor
an unsupported schema causes automatic deletion, repair, or reinitialization.

Randomness uses `os.urandom`; SQLite time comes from the badge RTC with explicit
epoch conversion. Foreground timing works without a set RTC; counting time away
requires the badge clock to stay accurate. The native callback boundary translates Python exceptions to SQLite
errors. Standard watchdog feeding continues through the app and filesystem
callbacks. Long CPU-only queries are outside this bounded app workload.

PowerSync uses `local_only` for this alpha. No dummy account, fake cloud rows,
credentials, upload queue, or mock network checkpoint is packaged. A later
paired client needs a separate account-aware schema and sync lifecycle; it must
not silently reinterpret this local snapshot as already-synced user data.

## Qualification

Host tests cover timer transitions and held buttons, Home arriving during a
save, owned-directory/path restrictions, preservation on invalid input,
interrupted journal detection, low-space refusal, and actual pinned PowerSync
local-only persistence. The host core fixture uses POSIX storage; it is not a
substitute for device testing.

Device installation, native import from FAT, rendering, close/reopen/reset
persistence, and before/after app fingerprints are recorded in
[`evidence/`](evidence/). Consult the [initial qualification](evidence/qualification.md)
and [timer update qualification](evidence/qualification-alpha2.md) for the exact
artifacts, what was exercised, and remaining limits.

Power-loss recovery, indefinite operation, fixed-arena exhaustion, Wi-Fi/TLS,
pairing, live sync, and AI remain unqualified. The alpha fails closed on retained
journals and unsupported data. No firmware change is required or included.
