# Timer update qualification — 2026-10-20

Badgegotchi alpha.2 was installed on the same Tufty 2350 using Badgeware's
ordinary USB disk mode. Home now preserves a running timer; reopening subtracts
elapsed badge-clock time. B still explicitly pauses the timer. Completion while
away is recorded once on reopening, and the next phase waits for B. There is no
background alert while another app is running.

## Artifacts and backup

- ZIP: `badgegotchi-0.1.0-alpha.2-a03391f5a485.zip`, 588,293 bytes.
- SHA-256: `a03391f5a48549138a1591489266365ccde288b0f51045d00c818af9994d7111`.
- 19 app files, 1,037,531 bytes uncompressed.
- The native module and qualified firmware are unchanged from
  [alpha.1](qualification.md).
- The checked updater verified the installed alpha.1 against its exact ZIP,
  backed it up on the host, staged/read back alpha.2, then swapped only the app
  directory. Both backups were retained. See [update record](update-alpha2.txt).
- A 33,792-byte host backup of the existing application database was saved to
  ignored `badge/dist/backups/state-before-alpha2.sqlite` before migration.
  It is private local recovery material, not a release artifact.

## Device results

1. The recognized v1 snapshot migrated to v2 in SQLite. The migration preserved
   all existing fields: 2,243,961 ms of focus time remaining, six pets, one water,
   one stretch, and zero completed focus sessions. It added only a null clock
   anchor. See [migration transcript](timer-upgrade-device.txt).
2. A temporary running snapshot with the same counters survived a normal reset.
   Restoration subtracted exactly 60 seconds using the device RTC. The fixture
   then restored the user's original paused progress and counters, verified
   `integrity_check=ok`, and confirmed an empty `ps_crud` using real PowerSync
   `0.5.4/cratesio`. See [reset transcript](timer-reset-device.txt).
3. The installed app launched through real `badgeware.launch()`, rendered eleven
   frames, saved, and closed. Real-font display bounds and visual states passed.
   See [UI transcript](ui-device-alpha2.txt). Simulated visual actions were not saved.

The first reset-verification helper attempted to set `sys.argv`, which this
MicroPython build does not expose. It failed before opening storage. The corrected
helper takes prepended fixture globals; the subsequent reset/restore passed.
The [failed helper transcript](timer-reset-harness-error.txt) is retained.

The first read-only inventory was interrupted by a serial disconnect, followed
by another disconnect on re-entry. No database was open. A normal reset, resumed
REPL entry, and explicit watchdog feeding allowed the complete scan to finish.
The interrupted [partial inventory](device-inventory-interrupted.txt) is retained.

## Preservation

The [completed inventory](device-after-alpha2.txt) and
[comparison](preservation-alpha2.json) retain all 196 protected existing files
with matching metadata, including 170 hashed app/asset/library files. Other
settings and state files were checked by metadata only. No recorded file was
removed. Additions are the retained old-app backup and macOS bookkeeping files.
Changes are confined to Badgegotchi's app/data, its AppleDouble metadata, and
normal `/state/loading.log` growth. The badge was reset normally after the scan
to return control to its existing launcher.

## Validation and limits

- All 50 Python tests passed, including elapsed restoration, single completion,
  unset/backward clock handling, migration preserving real host-core data,
  deferred Home cleanup, and checked-update backup/failure behavior.
  See [host log](host-tests-alpha2.txt).
- The existing browser installer suite passed 136 unit tests and 17 production
  browser tests. Alpha.2 was then staged for the browser and the production build
  passed its package hashes, TypeScript check, and Vite build.
  See [alpha.2 build log](web-build-alpha2.txt).
- Browser installation uses the directory picker to copy the app to the USB
  disk. The physical copy was performed by the host tool; the browser copy tests
  use a simulated drive. Browser updates remain unsupported; the qualified
  update is the separate checked developer tool.
- RTC accuracy remains a requirement for time away. An unset or backward clock
  pauses restoration; a forward clock adjustment can complete a phase early.
- The user confirmed alpha.1 controls, Home, and retained pet counts. Alpha.2
  has the automated installed-app/reset checks above; physical Home/reentry of
  the updated running timer has not yet been manually confirmed.
- Power-loss recovery and directory-swap atomicity remain unqualified. A nonempty
  startup journal is retained and causes a closed failure. The additive schema
  migration means replacing just the app with alpha.1 is not a supported downgrade.

No firmware changes, Git push, or deployment were performed. Pairing, live cloud
sync, and AI remain separate work.
