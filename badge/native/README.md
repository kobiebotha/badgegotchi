# Badgegotchi native runtime

This app-specific `.mpy` contains SQLite 3.54.1 and the real PowerSync 0.5.4 core.
It reuses the pinned headers, core archive and checked SQLite transformations
from `experiments/badgeware-native`; it does not change those historical sources
or device evidence. Build with `sh badge/native/build.sh` from the repository root
after preparing the feasibility prerequisites. The build never accesses a badge.

`prepare.py` checks the SQLite source, every transformation, transformed source
hash, and the qualified softfp/PIC PowerSync archive hash. `pin.py` records the
result in `module.json` and generates `badgegotchi_identity.py` for the app's
runtime integrity gate. A rebuilt artifact needs device qualification before
release, even when it came from the same pinned sources.

The Python store supplies the same nine file operations as the feasibility VFS,
plus operation 9 for `os.urandom` entropy and operation 10 for RTC days/seconds
since the Unix epoch. The C boundary catches Python exceptions. RTC time is not
treated as trusted network time; foreground timing uses monotonic ticks, while
restoration after Home uses the badge clock with unset/backward-clock checks. The loader
checks the observed firmware build, `.mpy` ABI, artifact length and SHA-256, and
imports only from its own verified app directory.

The wrapper owns one database connection and returns text/None results, with at
most 32 rows per statement. Initialization failure closes the SQLite connection.
SQLite and Rust share a 256 KiB fixed arena; the WSD pool is 16 KiB. Native code
and fixed buffers remain allocated until Badgeware's VM reset on app exit.
The upstream no-std Rust panic handler loops on an infallible allocation failure;
the app watchdog remains enabled. General allocator exhaustion is not qualified.

The app's exact storage paths are `/state/badgegotchi/state.sqlite` and its DELETE
journal. The owner marker prevents adopting another directory. The database is
limited to 128 KiB and one bounded local-only PowerSync snapshot row; changes do
not enter `ps_crud`. The store checks existing schema/version/integrity, reserves
space for a journal plus other Badgeware state, and retains suspicious files.
It refuses nonempty startup journals because LittleFS truncation and rollback
recovery are unqualified. No WAL, VACUUM, database shrinking, automatic repair,
concurrent access, cloud sync, or power-loss durability is claimed.

`python3 -m unittest discover -s badge/tests -p test_storage.py -v` covers ownership,
path restrictions, journal retention, invalid snapshots, reserve checks and
entropy/time callbacks. When the pinned feasibility host library is present it
also runs real PowerSync local-only persistence and schema-preservation tests.
Host POSIX tests do not substitute for testing the installed FAT app and the
Badgeware LittleFS bridge on the badge.
