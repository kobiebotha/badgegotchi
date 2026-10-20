# Badgeware native module feasibility handoff

Prepared 2026-10-20. Continue this work in a new chat.

**Completed:** the [native feasibility report](../../experiments/badgeware-native/README.md)
records the successful staged tests. The subsequent [installable app](../../badge/README.md)
and its [qualification](../../badge/evidence/qualification.md) now implement the
ordinary Badgeware app path. The original handoff below is retained as context.

## Goal and user decision

Determine whether Badgegotchi can run SQLite and the real PowerSync core as an ordinary app on the badge’s existing Badgeware firmware. Preserve the launcher, other apps, settings, and existing data.

The user interrupted the standalone firmware direction and asked whether Badgegotchi could be installed as a Badgeware app instead. The next task is a feasibility experiment, beginning with a small native MicroPython `.mpy` module. This experiment has not started. No firmware was flashed during the installer work or the subsequent firmware planning.

Proceed with local builds, read-only device inspection, temporary module execution, and isolated test files. Do not replace or upgrade firmware, format storage, write raw flash, or silently substitute a standalone firmware experiment. If the installed runtime cannot support the approach, report the exact blocker and options before changing architecture.

Other user rules:

- Never `git push`; the user does that.
- Never blanket-stage files with `git add .` or `git add -A`.
- Plans involving PRs require distinct local branches.
- Never deploy to the PowerSync Vercel organization without user approval.

## Workspace and current work

The current chat runs on macOS. Its working directory is `/Users/kobie/projects/powersync/skunkworks/powerbadge`.

| Location | Purpose |
| --- | --- |
| `/Users/kobie/projects/powersync/skunkworks/badgegotchi` | Product repository: React/Vite web app, backend configuration, installer work, this handoff |
| `/Users/kobie/projects/powersync/skunkworks/powerbadge` | Badge experiments, existing MicroPython preview, native SQLite and PowerSync prototypes; this directory is not a Git repository |
| `/Users/kobie/projects/powersync/skunkworks/sqlite-littlefs-vfs` | Related SQLite storage work |
| `/Users/kobie/projects/powersync/skunkworks/pomogotchi` | Earlier product implementation |

Use a new experiment directory such as `/Users/kobie/projects/powersync/skunkworks/badgegotchi/experiments/badgeware-native/` for reproducible source, build scripts, and findings. Inspect applicable instructions before editing another repository.

The `badgegotchi` checkout has substantial uncommitted installer work. Preserve it. Inspect `git status --short` before editing; do not reset or clean it. Relevant files:

- `/Users/kobie/projects/powersync/skunkworks/badgegotchi/web/src/components/BadgeInstaller.tsx`
- `/Users/kobie/projects/powersync/skunkworks/badgegotchi/web/src/installer/`
- `/Users/kobie/projects/powersync/skunkworks/badgegotchi/web/public/firmware/manifest.json`
- `/Users/kobie/projects/powersync/skunkworks/badgegotchi/docs/badge-installer.md`

That installer currently targets the RP2350 BOOTSEL firmware loader through WebUSB. Its manifest is `{ "schemaVersion": 1, "release": null }`; no qualified firmware is published, and installation remains disabled. Its browser tests use simulated USB. It is not a Badgeware app installer, and its documentation predates the user’s correction.

The web preview was at `http://127.0.0.1:4173/install`; do not assume its process is still running. Website changes and deployment are unnecessary for this feasibility test.

## Badgeware and existing evidence

The target is a Pimoroni Tufty2350 / Supabase Select badge with RP2350B, 16 MiB flash, and 8 MiB PSRAM. A previous device observation reported MicroPython 1.29.0, build 2026-09-22, and `bw-1.29.0-gc`. Rediscover the connected device and verify its actual firmware rather than assuming those observations still apply.

An ordinary Badgeware app already exists at:

- `/Users/kobie/projects/powersync/skunkworks/powerbadge/apps/pomogotchi/README.md`
- `/Users/kobie/projects/powersync/skunkworks/powerbadge/apps/pomogotchi/__init__.py`
- `/Users/kobie/projects/powersync/skunkworks/powerbadge/tools/pomogotchi_smoke.py`

It displays Mochi, a static timer, and canned responses. It has no persistent sync or cloud inference. It demonstrates the app/launcher model, not native SQLite feasibility.

On the stable Badgeware workflow, double-tapping rear Reset exposes the USB disk; copying an app folder into `apps/` installs it. BOOT plus Reset enters the separate ROM firmware loader. The stable layout maps the app directory to `/system/apps/`, and `/system` is normally read-only while running. Other firmware versions differ; inspect the installed version before choosing an installation path. See [Pimoroni app installation](https://github.com/pimoroni/tufty2350#installing-apps) and [alternative Badgeware workflows](https://learn.pimoroni.com/article/alternative-badgeware-workflows).

Existing native experiments separately demonstrated SQLite storage, real PowerSync core execution/footprint, PSRAM use, and Wi-Fi/TLS. They used standalone or host environments. None proves these components load safely inside the current Badgeware runtime.

There is no unused flash partition in the previously inspected layout:

| Flash-relative range | Existing use |
| --- | --- |
| `0x000000–0x200000` | Firmware |
| `0x200000–0x300000` | ROMFS |
| `0x300000–0xf00000` | FAT `/system` |
| `0xf00000–0x1000000` | LittleFS `/` |

A historical full-flash backup exists at `/Users/kobie/projects/powersync/skunkworks/powerbadge/dist/tufty-before-sqlite-2026-10-19.bin`. It is 16,777,216 bytes with SHA-256 `e7fab8eea70963ee85f2e031ac731ceb7847747e5505a99f81f305b8b8fd3f57`. Treat it as private and historical, not permission to overwrite or restore the badge. Do not publish flash contents, Wi-Fi settings, tokens, or secrets.

## Technical questions to resolve

**ABI and loader:** Match the installed MicroPython `.mpy` version/native subversion, architecture, object representation, and floating-point ABI. Pimoroni’s v3.1.1 board source uses `MICROPY_OBJ_REPR_C` and a PSRAM heap, but that does not establish which source revision is installed. Resolve and pin compatible sources before building.

**Linking:** Native `.mpy` modules use position-independent code and a restricted dynamic runtime interface. Arbitrary firmware symbols are not exported. Writable initialized data, static BSS, and relocations need explicit inspection and may require adaptation. The existing static PowerSync archive is not a ready-to-load module. `SQLITE_OMIT_WSD` is a candidate to investigate, not a proven solution.

**Memory:** The previous combined SQLite/PowerSync size experiment measured approximately 705 KiB code/rodata and 264 KiB BSS, including a 256 KiB arena. Those are standalone build measurements, not the dynamic module’s runtime budget. Determine native code placement, PSRAM execution, heap/stack requirements, and GC ownership inside Badgeware.

**Storage ownership:** SQLite persistence must cooperate with MicroPython’s existing VFS. Do not mount a second LittleFS instance over a mounted partition. Do not transplant standalone raw flash, QMI, IRQ, allocator, or Embassy runtime code into Badgeware.

## Test sequence

### 1. Inspect the installed runtime

Discover the current USB/serial device and collect `sys.implementation`, `sys.implementation._mpy`, `os.uname()`, available memory, filesystem availability, and firmware identity without reading secret file contents. Inspect supported commands before using `mpremote`.

Locate matching MicroPython/Pimoroni headers, `py/dynruntime.mk`, and `tools/mpy_ld.py`. Record revisions, tool versions, and architecture choices. Do not upgrade firmware to make a guessed ABI work.

Prefer temporary host-mounted module files. If on-device files are needed, use a clearly owned directory such as `/state/badgegotchi-feasibility`, after checking it does not contain unrelated data. Record the baseline needed to verify preservation.

### 2. Load a tiny native module

Build a minimal native C `.mpy` with a deterministic callable result. Import it on the actual badge and capture the result. Exercise repeated calls, garbage collection, launcher exit/re-entry, and a normal reset.

Record source/tool revisions, compiler flags, binary hash, and device transcript. A standalone ELF running from RAM does not satisfy this stage.

If import fails, identify the exact version, architecture, relocation, section, or symbol failure. Resolve compatible build choices where possible; stop before any firmware change.

### 3. Establish memory and SQLite execution

Determine where native text, constants, mutable state, and allocations reside. Use bounded allocation tests and normal display activity to assess GC lifetimes and available memory. Avoid arbitrary memory writes or unbounded stress tests.

Add SQLite to the module and demonstrate an in-memory database: create a table, insert/select values, commit a transaction, and roll back another. Inspect ELF sections, relocations, unresolved symbols, and mutable globals. Record memory use and cleanup after repeated database open/close operations.

### 4. Demonstrate persistence through Badgeware

Implement the smallest SQLite VFS bridge supported by the installed MicroPython runtime. Evaluate seek/read/write, truncation, synchronization, locking, error propagation, and journal behavior. Do not claim power-loss durability from a successful reopen alone.

Use a unique test database in the isolated writable directory. Verify committed data survives close/reopen and a controlled reset after database closure. Check transaction rollback and `PRAGMA integrity_check`. Verify the launcher, unrelated apps, and baseline files still work. Do not deliberately interrupt flash writes or power-cycle during writes at this stage.

If the dynamic runtime cannot provide the required filesystem bridge, report the missing interface explicitly.

### 5. Load and exercise the real PowerSync core

Rebuild the pinned Rust core for the native-module requirements. Inspect PIC/GOT output, compiler-builtins, writable statics, and unresolved runtime symbols against the loader. Keep `panic=abort` and prevent unwinding across the Python boundary.

Register the actual PowerSync SQLite extension using the existing prototype’s integration as a reference. Adapt deterministic host fixtures to exercise a checkpoint, query a synced row, and inspect local CRUD/outbox behavior. Reopen the persistent database and verify retained state.

Do not call a trivial native import, ordinary SQLite, a mock extension, or an SRAM-only standalone program proof of PowerSync feasibility. If a stage is blocked, preserve the smallest reproducer and report the exact blocker.

Live cloud sync, credential provisioning, Wi-Fi onboarding, and AI responses are later work. They are not necessary to establish native module feasibility.

## Reusable local sources and tools

All paths below are under `/Users/kobie/projects/powersync/skunkworks/powerbadge/`:

| Path relative to that directory | Use |
| --- | --- |
| `native/with-toolchain.sh` | Existing toolchain wrapper |
| `native/sqlite-hello/powersync/build_core.sh` | PowerSync static build reference |
| `native/sqlite-hello/powersync/fetch.py` | Pinned source/integrity handling |
| `native/sqlite-hello/powersync/vendor/powersync-ja-powersync-sqlite-core-0ed9f4e/` | Existing pinned PowerSync source |
| `native/sqlite-hello/vendor/sqlite-littlefs-vfs/vendor/sqlite/sqlite3.c` | SQLite amalgamation |
| `native/sqlite-hello/sqlite/config.h` | Constrained SQLite configuration |
| `native/sqlite-hello/powersync/psram-layout/build_payload.sh` | Existing C/Rust link inputs and flags; not a dynamic module builder |
| `native/sqlite-hello/powersync/badge-size/README.md` | Footprint measurements |
| `native/sqlite-hello/powersync/psram-layout/README.md` | Standalone PSRAM evidence and limitations |
| `native/sqlite-hello/powersync/physical-flash/README.md` | Standalone storage evidence |
| `native/sqlite-hello/powersync/networking/host/README.md` | Host protocol/checkpoint experiment |
| `native/sqlite-hello/docs/flash-layout.md` | Flash layout and preservation context |

Existing tools live under `native/.tools/`. Prior builds used Arm GNU 13.2.Rel1, Rust 1.91.1 for the demo, and Rust 1.96.0 for PowerSync 0.5.4. The core build script fetches with Cargo 1.91.1 because the newer client stalled on this Mac, then builds offline with 1.96.0. `POWERSYNC_OFFLINE=1` supports cached dependencies. Inspect scripts before reuse; their existing static linking flags are not validated for `.mpy`.

The previous target was `thumbv8m.main-none-eabihf`. Do not assume the native module uses exactly the same architecture selection. Match the device and loader first.

## Completion and report

Leave reproducible experiment sources and commands, pinned dependencies, a small device smoke script, and a report distinguishing **verified**, **blocked**, and **untested** stages. Include memory measurements, exact failures, preservation checks, and cleanup instructions for owned test files.

The successful outcome is evidence that an app-installable module can run SQLite and the real PowerSync core with persistent storage while stock Badgeware remains usable. This would still leave networking, provisioning, full sync lifecycle, and product polish to qualify.

If blocked, explain whether the smallest remedy would be an additional runtime export, a native-module adaptation, or a firmware rebuild. An extended Badgeware build that retains its launcher is an option to discuss with the user, not an authorized fallback.

For the later installer, prefer copying app assets/modules to the mounted badge using a browser directory picker, with a ZIP/manual-copy fallback. Verify the exact firmware’s filesystem workflow before implementing it. Keep the current BOOTSEL flasher out of the ordinary app installation path.

## Later cloud context

The user previously authorized these as development targets:

- Supabase: `https://bfccerfayrfolisawokp.supabase.co`
- PowerSync: `https://6ad76c8f2f27853eb0b0a128.powersync.journeyapps.com`

The OpenAI key is already stored server-side as `OPENAI_API_KEY` in Supabase. Do not retrieve it for the badge or put it in app assets. Backend AI accepts badge-originated events, but badge pairing, credential refresh, and trusted-time provisioning are not implemented. No backend mutation is needed for this experiment.

## Primary references

- [MicroPython native module support and limitations](https://docs.micropython.org/en/latest/develop/natmod.html) — use the version matching the device when implementing.
- [MicroPython external C modules](https://docs.micropython.org/en/latest/develop/cmodules.html) — compiled-in modules require rebuilding firmware.
- [Pimoroni v3.1.1 board configuration](https://raw.githubusercontent.com/pimoroni/tufty2350/v3.1.1/board/mpconfigboard.h) — reference ABI, not proof of the installed version.
- [Pimoroni v3.1.1 filesystem boot configuration](https://raw.githubusercontent.com/pimoroni/tufty2350/v3.1.1/modules/common/_boot_fat.py).
- [Pimoroni firmware releases](https://github.com/pimoroni/tufty2350/releases) — filesystem and installation workflows vary across versions.
- [Browser File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) — candidate for the later app-file installer.
