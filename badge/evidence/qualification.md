# Initial alpha.1 app qualification — 2026-10-20

The subsequent [alpha.2 timer update](qualification-alpha2.md) changes Home/reentry
to account for elapsed time using the badge clock. This report records alpha.1.

The local alpha was built, copied to the connected badge's ordinary USB disk,
and exercised from `/system/apps/badgegotchi` under the existing firmware.
No firmware image, launcher, existing app, or existing user data was replaced.

## Exact artifacts

- Version: `0.1.0-alpha.1`.
- ZIP: `badgegotchi-0.1.0-alpha.1-8c63b2950555.zip`.
- ZIP bytes: 587,342; 19 app files, 1,034,133 bytes before compression.
- ZIP SHA-256: `8c63b2950555add17cb969958a7665a4ab32010c58a95b09896f1f79f9a11275`.
- Native module: 737,049 bytes; SHA-256
  `802223bc6d2f7daea4c04b975bf2c6208068ef968891557e726bd485d3efafa8`.
- Runtime: Pimoroni Tufty 2350, MicroPython 1.29.0,
  `bw-1.29.0-gc,   on 2026-09-22 (GNU 13.3.1 MinSizeRel)`, `_mpy=7942`.
- SQLite 3.54.1; actual PowerSync core `0.5.4/cratesio`.

## Passed on the badge

1. The host installer created only the new app folder, checked all 19 files
   after copying, and wrote its entrypoint last. The disk was safely ejected
   before a normal firmware reset. See [install.txt](install.txt).
2. The exact native module imported directly from the copied FAT app folder.
   No host filesystem mount or RAM import workaround was used.
3. The real PowerSync local-only table retained timer and wellness values across
   close/reopen and a normal reset. Reopening paused the running timer; `ps_crud`
   stayed empty and `integrity_check` returned `ok`. The qualification fixture
   refused non-default existing app state, then restored its initial defaults
   after checking reset persistence. See [storage-device.txt](storage-device.txt)
   and [reset-reopen-device.txt](reset-reopen-device.txt).
4. The new entropy callback generated distinct random blobs. SQLite returned
   the badge RTC date instead of the feasibility fixture's fixed time. RTC
   trust/provisioning was not established.
5. A real `badgeware.launch()` rendered 12 frames with the store open, then
   saved and closed normally. Timer, pet animation, action acknowledgements,
   extreme counter values, and error screens passed real-font display bounds
   checks. [Captured app screen](app-screen.png), [transcript](ui-device.txt).

The create/save/close/reopen storage script took 13.918 seconds in total. The
observed arena peak was 132,096 bytes. At the final display collection there
were 6,863,360 free MicroPython heap bytes. These are bounded measurements,
not a long-running performance or memory guarantee.

The first display harness attempt used an unsupported lookup of `builtins.run`
and failed before opening the app. The harness now resolves the firmware's
hoisted `run` name correctly; the subsequent installed app/display test passed.

## Preservation

[Before](device-before.txt) and [after](device-after.txt) inventories and
[comparison](preservation.json) show all 196 protected existing files retained
their recorded metadata. All 170 existing hashed app/asset/library files matched.
Secret/settings/state contents were not read; their checks are metadata-only.
The feasibility experiment's directory was deliberately left alone.

Normal firmware logging grew `/state/loading.log` from 9,847 to 10,230 bytes.
USB disk use also removed three macOS `.fseventsd` bookkeeping files and created
AppleDouble `._` metadata beside the new app files. These are recorded rather
than counted as unchanged app/user data. The ZIP itself has no AppleDouble files.
New persistent app data is only `/state/badgegotchi/owner.txt` and
`/state/badgegotchi/state.sqlite`.

## Host and browser validation

- 39 Python tests passed: timer/button edges, deferred Home during a save,
  ownership, schema and journal refusal, actual host PowerSync persistence,
  native ABI/hash gates, ZIP integrity and deterministic output, exclusive
  installation, preservation, failure cleanup, and low-space checks.
  See [host-tests.txt](host-tests.txt).
- 136 web unit tests and 17 production installer browser tests passed.
  TypeScript and the production build passed with all release artifact hashes
  verified by the build guard.
- Installer desktop and mobile layouts were inspected. Screenshots use the
  browser test's mock filesystem/release fixture, not a physical browser copy:
  [desktop](installer-desktop-ready.png), [mobile top](installer-mobile-top.png),
  [mobile controls](installer-mobile-controls.png).

## Remaining limits

The physical copy was performed by the host installer; a real browser directory
picker and manual Finder drag/drop were not separately exercised. The browser
filesystem failure paths use a simulated drive.

The user confirmed that the controls and Home worked and the pet count survived
Home/reentry. They also observed alpha.1's timer pausing on Home and requested
continued counting while away, addressed in alpha.2. The automated
Home-during-save test verifies foreground-close ordering; the device smoke
verifies normal bounded launcher return.

Power-loss recovery is unqualified. Nonempty leftover journals cause a preserved,
closed failure state because the firmware has no file truncation API. Database
shrinking, WAL, concurrent access, updates, allocator exhaustion, and indefinite
operation are outside this alpha. Pairing, cloud sync, Wi-Fi/TLS provisioning,
and AI are not implemented here. The core stores a local-only snapshot, not a
pretend cloud checkpoint or upload queue.

No Git push or deployment was performed.
