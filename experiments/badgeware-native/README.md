# Badgeware native feasibility — measured 2026-10-20

**The bounded feasibility experiment passed on the existing badge firmware.**
A dynamically loaded MicroPython `.mpy` ran SQLite and the **real PowerSync
0.5.4 core**, applied a deterministic checkpoint, queued local CRUD, and retained
the database across close/reopen and a normal reset. No firmware, launcher, or
installed app was replaced. This is an experimental native module and storage
bridge, not a finished Badgegotchi app or a general-purpose SQLite driver.

The remaining storage blocker is explicit: this firmware's LittleFS file API
does not expose truncation. `DELETE` journal mode passed; `TRUNCATE` journal mode
produced the expected disk I/O error. General rollback recovery and database
shrinking are not qualified.

## Results and evidence

| Stage | Result | Device evidence |
| --- | --- | --- |
| Runtime identification | Verified MicroPython 1.29.0, `bw-1.29.0-gc`, `_mpy=7942` | [Before inventory](evidence/device-before.txt) |
| Tiny native module | Integer `42`, float `1.75`, 1,025 calls with GC; bounded 16/64/256 KiB allocations | [Tiny smoke](evidence/tiny-device.txt) |
| App lifecycle | Three `badgeware.launch()` entry/exit cycles, normal display updates, module removed from `sys.modules` | [Lifecycle](evidence/lifecycle-device.txt) |
| Normal reset | Tiny native module imported and passed again | [After-reset tiny smoke](evidence/tiny-after-reset.txt) |
| SQLite in memory | Create/insert/select, commit, rollback, floating-point arithmetic, integrity; six open/close cycles | [SQLite memory](evidence/sqlite-memory-device.txt) |
| SQLite persistence | Commit/rollback, close/reopen, `integrity_check=ok`, then retained row after normal reset | [Persistence](evidence/sqlite-persistence-device.txt), [reset/reopen](evidence/sqlite-reset-reopen-device.txt) |
| Real PowerSync in memory | Actual extension version; checkpoint published only upon completion; local PUT/PATCH queued; rollback absent | [Core memory](evidence/powersync-memory-device.txt) |
| Real PowerSync persistence | Same fixture through Badgeware VFS; close/reopen preserved synced row, oplog and outbox; integrity OK | [Core persistence](evidence/powersync-persistence-device.txt) |
| Real PowerSync after reset | `Hello world` / `7`, local value `11`, two CRUD entries in one transaction, one oplog entry, integrity OK | [Core reset/reopen](evidence/powersync-reset-reopen-device.txt) |
| Existing apps and GC | Installed Pomogotchi and Dots & Boxes each rendered 11 frames; native DB stayed valid across app cleanup/GC | [App smoke](evidence/apps-smoke-device.txt) |
| Error boundary | Python VFS exception became SQLite error 10; interpreter and subsequent SQL remained usable | [Boundary checks](evidence/vfs-limits-device.txt) |
| Truncation | **Blocked:** journal shrink from 512 to 0 returned `SQLITE_IOERR_TRUNCATE` (1546), surfaced as primary error 10 | [Small reproducer](tools/vfs_limits.py), [device result](evidence/vfs-limits-device.txt) |

The PowerSync fixture uses the pinned upstream extension, not mocked functions
or a replacement state machine. [fixture.py](powersync-audit/fixture.py) calls
`powersync_replace_schema`, `powersync_control`, and the real checkpoint protocol.
Its host qualification was preparation; the device transcripts above establish
the Badgeware result. There was no cloud access or credential provisioning.

## Preservation

The badge initially appeared as `RP2350 Boot`. `picotool reboot --application`
started the existing installation. No load, flash, erase, format, upgrade,
raw-flash write, partition change, or alternate firmware execution was performed.

Before/after inventories contain 200 existing files. All **173 hashed app/asset
files matched**, including `/system/main.py` and the installed applications.
Other existing files had matching metadata, except `/state/loading.log`, which
grew from 8,083 to 9,532 bytes during normal firmware startup/reset logging.
Secret files and state/settings contents were not read or copied; their
preservation check is metadata-only. This is not a full-flash hash comparison.
See [preservation.json](evidence/preservation.json) and
[comparison script](tools/compare_preservation.py).

The user confirmed the normal launcher worked after the tiny-module reset and
again after the final SQLite and real PowerSync tests. Existing-app execution
also passed, and each successful database test closed its connections before
returning to the normal launcher with a reset.

Device writes were restricted to the new, marker-owned directory
`/state/badgegotchi-feasibility`. It contains:

- `owner.txt`
- `probe-sqlite-v1.db` — 2,048-byte successful SQLite fixture.
- `probe-powersync-v2.db` — 34,816-byte successful PowerSync fixture.
- `probe-powersync-v1.db` and its journal — retained first-attempt watchdog
  interruption evidence; not used as the successful database.
- `probe-truncate-v1.db` and its journal — retained truncation failure reproducer.

Host-mounted files and a temporary **RAM-only Python VFS** supplied the modules.
No second LittleFS instance was mounted over device storage. The temporary RAM
mount is removed immediately after import. Native code lives in the existing
MicroPython heap until VM reset.

The repository's pre-existing installer changes remain untouched. No files
were staged, committed, pushed, or deployed.

## ABI, dependencies, and build adaptations

Observed device:

```text
Pimoroni Tufty 2350 with RP2350
MicroPython 1.29.0, build tufty
bw-1.29.0-gc, on 2026-09-22 (GNU 13.3.1 MinSizeRel)
sys.implementation._mpy = 7942 = 0x1f06
```

That value decodes to `.mpy` version **6**, native subversion **3**, architecture
**7 / armv7emsp**. The MicroPython source tag reported by the runtime resolves to
`pimoroni/micropython@41d1e007537f9b15cf13a9436228dd59d6485eca`.
Its archive SHA-256 is
`78e2a572f6048c80d1fbd65aa9149127eb145b42c54264c4d20580f838f03821`.
We used that revision's headers, `py/dynruntime.mk`, `tools/mpy_ld.py`, and
`mpy-tool.py`. No loader source was patched.

The board's exact full firmware Git identity was not exposed (`version` was
unavailable). Pimoroni Tufty v3.1.1 board source specifies `MICROPY_OBJ_REPR_C`;
the matching runtime tag and successful integer, float, buffer, GC and exception
tests establish the compatible dynamic ABI here. They do not assert a byte-for-
byte match to an official release image.

Local tools: Arm GNU **13.2.Rel1 / GCC 13.2.1**, Rust **1.96.0**
(`ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96`), mpremote **1.29.0**,
pyelftools **0.32**, `ar` **1.0.1**.

Important build discoveries:

1. The default native makefile uses `-mfloat-abi=hard`, but this Badgeware build
   uses the Pico SDK's **softfp calling convention**. The initial float probe
   returned `1.25` instead of `1.75`. Appending `-mfloat-abi=softfp` fixed it.
   The architecture header alone does not identify this ABI.
2. Native code uses `-fpic -fno-common -Os`, `armv7emsp`, float implementation
   `float`, and object representation C. The tiny module's static BSS reference
   was rejected by `mpy_ld`; external linkage produced the supported GOT access.
3. SQLite **3.54.1**, source SHA-256
   `0c657666d819f261cc4007526ad57e1669de9949df7a8ea847aa284a2bf0ee52`,
   reuses the existing constrained SQLite configuration with `SQLITE_OMIT_WSD`,
   `SQLITE_OMIT_DESERIALIZE`, and `SQLITE_OMIT_EXPLAIN`.
   `SQLITE_OMIT_WSD` alone still produced rejected writable `.data`.
   [adapt_sqlite.py](sqlite-audit/adapt_sqlite.py) copies mutable function
   definition tables into keyed WSD storage, moves immutable descriptors and
   local initializer templates to const sections, and exposes remaining BSS
   globals for GOT references. The upstream amalgamation is not edited.
   Every replacement is count-checked; exact changes and hashes are in
   [source-adaptations.json](sqlite-audit/source-adaptations.json).
4. The real PowerSync core is **0.5.4**, commit
   `0ed9f4edba418a4f8ae7cb0594da683cd79a81b5`. Its pinned source integrity
   check passes. It was rebuilt offline for **thumbv8m.main-none-eabi**, with
   `-C target-cpu=cortex-m33 -C relocation-model=pic -C panic=abort`,
   upstream size optimization/LTO and the `static` feature.
   Using the earlier `eabihf` archive would mix floating-point ABIs.
5. Rust's immutable `.data.rel.ro.*` descriptors and its GOT/REL32/ABS32/Thumb
   call relocations are accepted by the matching loader. Compiler builtins,
   softfp libgcc/libm, string helpers, SQLite symbols, and the dynamic runtime
   table resolve in the final native link. No arbitrary firmware address export
   is used. See [core archive audit](evidence/powersync-archive-summary.json),
   [SQLite objects](evidence/sqlite-object-summary.json), and
   [core wrapper objects](evidence/powersync-wrapper-object-summary.json).
6. The VFS's C entry points catch MicroPython exceptions using the existing
   dynamic table's NLR interface and return SQLite error codes. The SQL wrapper
   finalizes active statements if result conversion raises. No Rust unwind is
   permitted across the Python boundary.

## Memory and timing

| Quantity | Measured |
| --- | ---: |
| Tiny `.mpy` file | 466 bytes |
| SQLite `.mpy` file | 409,092 bytes |
| Combined PowerSync `.mpy` file | 736,614 bytes |
| SQLite linked text/rodata | 407,340 bytes |
| Combined linked text/rodata | 733,428 bytes |
| SQLite/combined BSS | 279,256 bytes |
| Shared SQLite/Rust arena included in BSS | 262,144 bytes |
| Fixed WSD buffer included in BSS | 16,384 bytes |
| WSD actually used | up to 6,472 bytes / 14 entries |
| Combined module retained after GC | 1,013,120 bytes |
| SQLite-only fixture arena peak | 55,872 bytes persistent; 26,688 in memory |
| Core fixture arena peak | 181,056 bytes in memory; 135,488 persistent |
| SQLite live allocation after each memory close | 0 bytes, six cycles |
| Core live allocation after memory close | 0 bytes |
| Combined host-cache/import time | about 2.9 seconds |
| Real-core in-memory fixture time | 1.334 seconds |
| Persistent fixture plus close/reopen | 45.635 seconds |

Native text, constants, BSS and Python buffers had `0x110...` / `0x111...` /
`0x112...` addresses in PSRAM; the C stack was at `0x20081dc4` in SRAM.
The tiny bounded-allocation test retained the final temporary block until a
later collection/stack cleanup; it was not an exhaustive fragmentation test.
The combined module left approximately 7.19 MB free during the app smoke.

The native loader retains relocated code roots until VM reset. Removing a module
from `sys.modules` alone is not an unload mechanism: tiny repeated app imports
retained roughly 512 bytes per subsequent cycle. SQLite closing releases its
arena allocations, **not** the module's fixed arena/code allocation. Badgeware's
normal reset on app exit is compatible with this lifecycle.

The persistence fixture deliberately used a two-page SQLite cache. It performed
599 reads, 321 writes, 48 sync calls, and no truncations. These timings are not a
performance claim for a product configuration.

## Blockers and limits before any firmware discussion

**Missing truncation interface.** The installed LittleFS file stream exposes
seek/read/write/flush/close, but no truncate method or supported truncate ioctl.
The bridge returns extended error **1546** for shrinking. The real `TRUNCATE`
journal test reached `xTruncate(512 → 0)` and failed as expected. The successful
fixtures used `DELETE` journal mode and never called xTruncate. VACUUM, file
shrinkage, and all rollback/hot-journal recovery cases therefore remain
unqualified. A module-side truncate adapter would need separate atomicity and
failure testing. If that cannot meet requirements, exposing the existing
LittleFS truncate operation would be a focused firmware option to discuss;
no firmware change is authorized or implemented here.

**Watchdog servicing is required.** An active hardware watchdog was observed
(`WATCHDOG_CTRL` enable bit, timeout reset reason `1`). Direct host-mounted
imports exceeded its deadline because the native loader made many tiny serial
reads. Reading the same file in 4 KiB chunks succeeded and matched its SHA.
The RAM cache fixed import time. The first persistent core attempt also exceeded
the watchdog deadline, leaving the isolated `v1` database/journal. This was an
unintended reset, not a deliberate write-interruption test. That file's recovery
is untested. The successful `v2` test used the standard `machine.WDT(timeout=16000)`
API and fed it between SQL statements and during VFS operations, then closed
everything before normal reset. No direct watchdog register writes or firmware edits
were used. Long CPU-only operations still need a product lifecycle solution.

**Bounded allocator and panic handling.** Rust allocates through SQLite's arena.
The pinned stable no-std core has an infinite-loop panic handler despite
`panic=abort`. Exhausting an infallible Rust allocation can hang until watchdog
reset. Successful bounded fixtures do not qualify low-memory recovery, stack
headroom, or long-running fragmentation. WSD capacity is fixed; the observed
14 entries fit comfortably, but broader SQL features need review.

**Deliberately limited VFS.** One database connection and no external access;
locking is local to that assumption. No WAL/shared-memory support, concurrent
readers/writers, backup API qualification, or USB mass-storage coexistence while
writing. `flush()` reaches LittleFS `file_sync`; `os.sync()` in this firmware only
adds FAT block sync, so it is not evidence of additional LittleFS directory
durability. VFS time/randomness are deterministic fixture helpers and must be
replaced before product use. The wrapper returns SQL values as text/None.

**Untested:** power-loss durability; recovery of the watchdog-interrupted file;
installation/import from a copied app on the FAT volume; network sync, credentials,
TLS lifecycle, live server checkpoints, AI, UI responsiveness under long SQL,
and a complete Badgegotchi app/installer. No cloud or website mutation was needed.

The evidence supports continuing the ordinary Badgeware app approach. It does
not justify replacing Badgeware with standalone firmware.

## Reproduce

Work in this directory. Existing workspace toolchains and the pinned SQLite/core
sources under `powerbadge/native/sqlite-hello` are prerequisites. The scripts
currently reference this workspace's absolute source paths.

```sh
python3 tools/prepare.py
sh tools/build_tiny.sh
sh sqlite-audit/build.sh
sh powersync-audit/build.sh
sh sqlite-audit/build.sh WITH_POWERSYNC=1
```

The extra Rust target is `thumbv8m.main-none-eabi` on toolchain 1.96.0. If absent:

```sh
sh /Users/kobie/projects/powersync/skunkworks/powerbadge/native/with-toolchain.sh \
  rustup target add thumbv8m.main-none-eabi --toolchain 1.96.0
```

Discover the normal Badgeware serial device with `mpremote connect list`; do not
assume its port name remains the same. The local executable used was:

```sh
MPREMOTE=/Users/kobie/projects/powersync/skunkworks/powerbadge/native/.tools/uv/archive-v0/d72dw6_U1MNvOQwC/bin/mpremote
"$MPREMOTE" connect /dev/cu.usbmodem1101 mount tiny run tools/tiny_smoke.py + reset
"$MPREMOTE" connect /dev/cu.usbmodem1101 mount tiny run tools/lifecycle_smoke.py + reset
"$MPREMOTE" connect /dev/cu.usbmodem1101 mount . run tools/sqlite_memory.py + reset
"$MPREMOTE" connect /dev/cu.usbmodem1101 mount . run tools/sqlite_persistence.py + reset
"$MPREMOTE" connect /dev/cu.usbmodem1101 mount . run tools/sqlite_reopen.py + reset
"$MPREMOTE" connect /dev/cu.usbmodem1101 mount . run tools/powersync_memory.py + reset
"$MPREMOTE" connect /dev/cu.usbmodem1101 mount . run tools/powersync_persistence.py + reset
"$MPREMOTE" connect /dev/cu.usbmodem1101 mount . run tools/powersync_reopen.py + reset
"$MPREMOTE" connect /dev/cu.usbmodem1101 mount . run tools/apps_smoke.py + reset
"$MPREMOTE" connect /dev/cu.usbmodem1101 mount . run tools/vfs_limits.py + reset
```

Fresh persistence/reproducer scripts intentionally refuse existing database
paths. Reopen scripts use the retained successful files. Do not overwrite those
guards; choose new owned filenames or explicitly clean up first. Keep a normal
reset after closed-database tests so the stock launcher resumes watchdog feeding.
If a test unexpectedly raises before closure, inspect/close its connection before
resetting; do not deliberately reset an active writer.

SHA-256 of the actual modules exercised:

```text
badgeprobe.mpy
4151d04a6f5f38acf33eb5347975d8b67a68d6ccb9c863359ca4f3710cd11a4c
badge_sqlite.mpy
96b6c3c937f9e6f748339094e98aa7aabf50aaa14778a3f46799e27240d1788a
badge_powersync.mpy
4c08b86526c8a2b198d05b145c8a4dcb8d734d46de962c6aa324a07b6ed02e22
```

Build output and vendor trees are ignored by Git. These hashes identify the
tested artifacts; upstream `mpy_ld` archive resolution iterates Python sets, so
library layout/hash is not promised identical on an independent rebuild.

Optional cleanup, after all experiment connections are closed:

```sh
"$MPREMOTE" connect /dev/cu.usbmodem1101 run tools/cleanup_device.py + reset
```

That script requires the exact owner marker and refuses unexpected files or
subdirectories. Cleanup has **not** been run; successful databases and the
smallest failure reproducer are retained.

Primary source references: [MicroPython native modules](https://docs.micropython.org/en/latest/develop/natmod.html),
[matched MicroPython revision](https://github.com/pimoroni/micropython/tree/41d1e007537f9b15cf13a9436228dd59d6485eca),
[Tufty board reference](https://github.com/pimoroni/tufty2350/blob/v3.1.1/board/mpconfigboard.h).
