# Badgegotchi — pairing candidate

Version `0.1.0-alpha.4` supports one-time account pairing on the Tufty 2350
Badgeware app. It corrects the PowerSync request format and processes batched
projection changes incrementally. The development gateway is activated and
physical A/B/C enrollment is verified. This candidate still needs final
installed-app qualification before replacing the public alpha.2 release.

## Pair once

Once the badge gateway and web pairing flow are activated:

1. Sign in to the web app and choose **Pair a badge** to display a short-lived,
   12-symbol code containing only A, B, and C.
2. Open Badgegotchi on the badge. Press and release A, B, or C for each symbol;
   **Up** erases a symbol. The completed code submits automatically.
3. Compare the verification ID on the badge with the claim in the web app.
   Approve that exact ID only when they match.

The badge saves the approved device credential in its private state directory.
Later launches reconnect automatically without another code. Network failures
retain pending pairing and saved credentials for retry. The web app can list
and revoke paired devices; its last-contact time is historical, not proof that
a badge is online. Signing out of the web app does not revoke a paired badge.
Use the badge's existing configured Wi-Fi; the app does not replace its Wi-Fi
settings or launcher.

## Controls and shared data

Once paired:

- **A:** pet the capybara; this interaction stays on the badge.
- **B:** start or pause the local 40-minute focus / 10-minute break timer.
- **C:** log water for your account.
- **Up:** log movement for your account.
- **Down:** show or hide account totals, queued events, and retained local history.
- **Home:** save, close the connection and database, and return to the launcher.

Water and movement events enter a durable, bounded upload queue and retry after
connectivity returns. The daily account summary uses UTC dates. PowerSync reads
at most three current account records: pet details and speech, the account's
current timer projection, and the daily wellness summary. The artwork remains
the bundled capybara. The badge does not request AI responses or write pet state.

The badge timer is explicitly **local**: its controls and completed sessions do
not update the account timer. The downloaded account timer record does not
control it. A completed local focus phase prepares a paused break; a completed
break prepares a paused focus phase. A running timer counts time away using the
badge clock and records at most one completion when reopened. **Home** saves
without pausing; **B** pauses. An unset or backward-moving clock pauses timer
restoration safely. No timer alert can appear while another app is running.

A connection alone does not mean all changes have synced. `SYNCED` requires an
empty upload queue and a completed PowerSync checkpoint covering accepted
uploads. When the 16-event queue is full, additional wellness events are refused
with a message instead of silently discarded.

## Install

The supported device is the tested Pimoroni Tufty 2350, MicroPython 1.29.0,
Badgeware `bw-1.29.0-gc` dated 2026-09-22, native ABI `_mpy=7942` and softfp.
The app checks this runtime and its native module identity before loading native
code. Other firmware builds need qualification. This app does not upgrade firmware.

Use a qualified release after its backend has been activated:

1. Double-tap rear Reset to expose Badgeware's USB disk.
2. Extract the ZIP. Copy only `apps/badgegotchi` into the disk's existing `apps`
   folder, keeping the other folders and files in place.
3. If `badgegotchi` already exists, stop. The first-install flow does not overwrite
   app folders; use the repository's reviewed update procedure with backups.
4. Safely eject the disk and press Reset to return to Badgeware.
5. Select `badgegotchi` in the launcher and complete pairing.

The RP2350 BOOTSEL drive is a different mode. This package contains no UF2 image.
Use the checked updater to preserve the existing app and saved pairing.

## Data and limits

SQLite progress lives in owner-marked `/state/badgegotchi`. Pairing credentials
and pending wellness events live separately in `/state/badgegotchi-pairing`.
Neither directory is part of the app package. Removing the app folder leaves
saved data intact. The app never adopts or resets an unrelated state directory.

Recognized alpha.1/alpha.2 data migrates additively to schema 3, keeping the local
timer and counters plus a separate snapshot of progress before pairing. Historical
local counts are not uploaded as account events. Downgrading only the app after
migration is unsupported. Do not delete saved state to dismiss an error.

The runtime lacks file truncation. The app uses DELETE journaling, one
connection, a 128 KiB database limit, a 16-event upload queue, and bounded sync
frames. A leftover nonempty journal, unknown schema, damaged data, or insufficient
space stops the app while preserving files. Power-loss recovery, fixed-arena
exhaustion, and indefinite operation remain unqualified. The normal watchdog
stays active.

The package includes a public CA certificate, not a private key or device
credential. Credentials are generated on the badge under the reviewed stock
runtime RNG assumptions. See the repository's `badge/README.md` and
`experiments/badge-pairing-preflight/entropy-review.md` for the evidence and limits.
Artwork, dependency, and CA provenance are in `THIRD_PARTY_NOTICES.txt`.
