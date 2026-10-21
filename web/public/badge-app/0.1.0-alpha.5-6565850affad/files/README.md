# Badgegotchi — shared account app

Version `0.1.0-alpha.5` uses the same account totals, timer, and pet as the web
app. Pair once using A/B/C, then reconnect automatically. This development
release requires the shared-command gateway and account projection streams.

## Pair once

1. Sign in to the web app and choose **Pair a badge**.
2. Enter the displayed 12-symbol code by pressing and releasing A, B, or C.
   **Up** erases a symbol.
3. Compare the verification ID on both screens and approve the matching badge
   in the web app.

The approved credential is saved privately. Later launches reconnect without
another code. Web sign-out does not revoke a badge; use the web device list to
revoke it. The app uses Badgeware's configured Wi-Fi and existing launcher.

## Controls and account data

- **A:** pet your account companion; its reaction syncs to both screens.
- **B:** start, pause, or resume the account's 40-minute focus / 10-minute break timer.
- **C:** log water for your account.
- **Up:** log movement for your account.
- **Down:** show the account totals and pending actions. **B** on this screen stops the timer.
- **Home:** close the connection and database and return to the launcher.

All displayed totals come from the synced account summary for the displayed
UTC date. Focus and Break count ended sessions, including stopped sessions.
Pets counts pet presses; water and movement count their corresponding actions.
The badge uses the account pet's animal, name, and speech. There is no separate
badge progress or local timer.

Actions are saved to a bounded queue before the UI acknowledges them. Offline
timer controls show pending state, while totals stay at their last synced values.
On reconnection, accepted actions reach Supabase and PowerSync returns the same
account state to both devices. Conflicting timer commands are rejected visibly
instead of overwriting a newer timer. Stable command IDs prevent retry duplicates.

Completing a phase prepares the opposite phase paused. Stopping prepares the
same phase paused. Press B to resume it. A running timer uses account UTC times,
so Home does not pause it and reopening accounts for elapsed time. Another app
owns the badge VM while Badgegotchi is closed: no sync or alert can run then.
The badge clock must be set before it can record account actions.

`SYNCED` requires an empty command queue and a PowerSync checkpoint covering
accepted commands. Pet AI can still be processing independently. If the 16-action
queue fills, additional actions are refused visibly until it drains.

## Install

Supported runtime: Pimoroni Tufty 2350, MicroPython 1.29.0, Badgeware
`bw-1.29.0-gc` dated 2026-09-22, native ABI `_mpy=7942`, softfp. The app checks
this runtime and its native module identity before loading native code.
No firmware update is included.

Double-tap rear Reset to expose Badgeware's USB disk. For a first install, copy
only `apps/badgegotchi` from the ZIP into its existing `apps` folder. If that
folder already exists, use the repository's checked updater with backups.
Safely eject, press Reset, and launch Badgegotchi. BOOTSEL is a different mode.

## Storage and limits

The bounded PowerSync cache lives in `/state/badgegotchi`. Credentials and
pending commands live in the separately owned `/state/badgegotchi-pairing`.
Neither directory enters the app package. Schema 4 discards the old badge-only
counters and timer, as authorized for this development environment, while
retaining pairing, account binding, sync checkpoints, and queued account work.
It does not import old local progress or erase canonical account history.
Downgrading only the app after migration is unsupported.

PowerSync downloads at most three current records (`pet`, `timer`, `summary`),
each at most 1536 bytes. SQLite uses DELETE journaling, one connection, a 128 KiB
limit, and bounded stream parsing. An unknown schema, nonempty leftover journal,
damaged data, or insufficient space stops the app while preserving files.
Power-loss recovery, fixed-arena exhaustion, and indefinite operation remain
unqualified. The normal watchdog stays active.

The package contains only public app assets and a public CA certificate.
Artwork and dependency provenance are in `THIRD_PARTY_NOTICES.txt`.
