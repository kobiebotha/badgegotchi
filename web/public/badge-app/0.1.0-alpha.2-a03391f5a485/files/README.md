# Badgegotchi — local alpha

A 40-minute focus timer, 10-minute break timer, and Mochi the capybara.
Runs as an ordinary app on the qualified Tufty 2350 Badgeware runtime.

- **A:** pet Mochi.
- **B:** start or pause the timer.
- **C:** log water.
- **Up:** log a stretch.
- **Home:** save, close the database, and return to the existing launcher.

Each completed focus session adds one to the focus total and prepares a paused
break. A completed break prepares a paused focus session. The totals are lifetime
local totals. A running timer keeps counting while you are in the launcher or
another app: reopening accounts for elapsed time using the badge clock. If it
finished while away, the app records one completion and prepares the next paused
phase. It cannot display an alert while another app is running. **B** pauses the
timer; **Home** saves it without pausing. An unset or backward-moving badge clock
pauses restoration safely and shows a notice. Running timers checkpoint once per
minute as well as on actions and normal exit.

This alpha uses SQLite and the real PowerSync 0.5.4 core for a local-only table.
There is no account pairing, network sync, or AI connection in this build.
Mochi's acknowledgements are local text. The package contains no credentials.

## Install

The supported device is the tested Pimoroni Tufty 2350, MicroPython 1.29.0,
Badgeware `bw-1.29.0-gc` dated 2026-09-22, native ABI `_mpy=7942` and softfp.
The app checks this runtime before importing native code. Other firmware builds
need qualification; installing the app does not upgrade firmware.

1. Double-tap the rear Reset button to expose Badgeware's USB disk.
2. Extract the ZIP. Copy only its `apps/badgegotchi` folder into the disk's
   existing `apps` folder. Keep the other folders and files in place.
3. If `badgegotchi` already exists, stop. This first installer does not perform
   upgrades or overwrite existing app folders.
4. Safely eject the USB disk, then press Reset to return to Badgeware.
5. Select `badgegotchi` in the launcher.

The RP2350 BOOTSEL drive is a different mode. This package has no UF2 image.

## Data and limits

Saved progress lives separately in `/state/badgegotchi`, guarded by an owner
marker. Removing the app folder leaves its data intact. This app never adopts
or resets an unrelated state directory.

Version 0.1.0-alpha.2 adds a saved clock anchor to recognized alpha.1 data in one
transaction, retaining existing counts and timer progress. An older paused timer
stays paused until B starts it; no elapsed time is invented for old data.

The runtime lacks file truncation. The app uses DELETE journaling, one
connection, a bounded database, and no WAL or VACUUM. If it finds a leftover
nonempty journal, unknown schema, damaged data, or insufficient space, it stops
and preserves the files. Copy diagnostics for investigation; do not delete the
database or journal to dismiss the error. Power-loss recovery is not qualified.

The native core uses a fixed 256 KiB allocator; broader workloads and low-memory
recovery remain experimental. The normal badge watchdog stays active. See the
repository's `badge/README.md` and `experiments/badgeware-native/README.md` for
build instructions, measured tests, and remaining limitations.

Artwork and bundled dependency attribution are in `THIRD_PARTY_NOTICES.txt`.
