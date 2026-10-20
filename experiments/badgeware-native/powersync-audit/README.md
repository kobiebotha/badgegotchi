# Real PowerSync core audit for Badgeware native modules

This directory contains an offline build audit and a deterministic fixture for
the **actual** PowerSync SQLite extension. It does not open a device, alter
Badgeware, or establish that the `.mpy` has run on the badge. Device results belong
in the parent experiment's report.

## Reproduce

From this directory:

```sh
sh build.sh > build/softabi-build.log 2>&1
python3 qualify_host.py > build/host-fixture.log 2>&1
```

The first command requires the existing workspace tool wrapper and the installed
Rust `thumbv8m.main-none-eabi` target. It verifies pinned source hashes, uses cached
dependencies only, and writes its Cargo target directory here. The second
command uses the existing pinned host archive, builds a host dylib here, and runs
the fixture in a separate process with a 30-second timeout. Its temporary POSIX
database stays inside `build/` and is removed on success.

Source: PowerSync core **0.5.4**, commit
`0ed9f4edba418a4f8ae7cb0594da683cd79a81b5`, at
`powerbadge/native/sqlite-hello/powersync/vendor/powersync-ja-powersync-sqlite-core-0ed9f4e`.
The existing `powersync/fetch.py --check` verifies every pinned upstream source
file. Neither script modifies upstream.

Toolchain: Rust **1.96.0** (`ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96`,
LLVM 22.1.2), Arm GNU **13.2.Rel1**.

## Verified offline

The real `powersync_static` package builds with its `static` feature, disabled
defaults, upstream LTO / size optimization, and:

```text
--target thumbv8m.main-none-eabi
-C target-cpu=cortex-m33 -C relocation-model=pic -C panic=abort
```

Use the soft calling ABI. An initial `thumbv8m.main-none-eabihf` archive also
built, but the badge's floating point callback test established that its native
runtime interface uses the soft calling convention. `armv7emsp` in the `.mpy`
header does not establish the C calling convention. Rust directly invokes
SQLite functions with `double` arguments, so mixing the original hard ABI core
and soft ABI SQLite would be unsafe.

The soft ABI archive SHA-256 is
`d5b146ff16d488beb8038a43d32754c4c7e2a1fcfb1543033bf13c6a52b20e60`.
It is 6,824,824 bytes on disk, including 492 archive members and ignored metadata.
That is **not** the loaded module size.

`build/audit/summary.json` and the neighboring readelf/nm reports show:

- Main LTO object allocated sections: **312,269 bytes before final linking**.
- All 316 writable-flagged initialized sections are `.data.rel.ro.*`, totaling
  **5,376 bytes**. These contain immutable relocated descriptors and callback
  tables, not runtime writable state. There is no retained mutable `.data` or
  `.bss` in this main object.
- Allocated code/data uses `R_ARM_GOT_PREL`, `R_ARM_REL32`, `R_ARM_ABS32`,
  `R_ARM_THM_CALL`, and `R_ARM_THM_JUMP24`. All are implemented by the matching
  MicroPython linker. `.ARM.exidx` uses `R_ARM_PREL31` and is ignored by that
  linker.
- The matching `tools/mpy_ld.py` at MicroPython commit
  `41d1e007537f9b15cf13a9436228dd59d6485eca` explicitly accepts `.data.rel.ro`
  sections. It does not require moving those tables into mutable BSS.
- The main object requires SQLite symbols, ARM compiler builtins, `fmod`,
  `memcmp`, and `strlen`. The final combined link must resolve them from actual
  SQLite, inspected compiler builtins/libm, and native runtime-compatible
  memory/string helpers. A successful Rust archive build alone does not prove
  that final link.

The core's Rust allocator delegates to SQLite's `malloc`, `realloc`, and `free`.
It therefore shares the SQLite arena rather than introducing a separate
standalone allocator or firmware memory manager.

## Deterministic fixture

`fixture.py` takes `execute(sql)` and `scalar(sql)` functions so the identical
fixture can run through either a host or native wrapper. It uses no network,
credentials, or mock extension.

`fresh()` verifies the version, registers an `items` schema, starts the real
sync state machine, and feeds the existing host prototype's deterministic
checkpoint/data/completion sequence. The row is absent before checkpoint
completion and contains `Hello world` / `7` afterward. A committed local
insert/update creates PUT and PATCH entries in one CRUD transaction; a rolled
back write leaves no row or outbox entry. `reopened()` verifies the synced row,
two CRUD entries, one oplog entry, and `PRAGMA integrity_check`.

The host qualifier ran these checks with the real pinned extension and SQLite
3.54.1 in a **256 KiB shared arena**, including file close/reopen. This qualifies
the fixture and its API calls only. It is not Badgeware, MicroPython, PSRAM,
LittleFS, normal reset, or power-loss evidence.

For a wrapper returning only strings, its scalar adapter should convert
integer-looking results to integers; preserve other strings and `None`.
The fixture's seed response accepts integer `1` or string `"1"`.

## Runtime constraints still requiring qualification

Upstream `panic=abort` prevents Rust unwinding, but the stable no-std panic
handler in `crates/static/src/lib.rs` is an infinite loop. In particular, an
allocation failure in an infallible Rust allocation can hang the interpreter.
The bounded successful fixture does not qualify low-memory recovery.

Filesystem callbacks must translate failures into SQLite return codes.
MicroPython exceptions/NLR must not escape an active SQLite/Rust call. The
same constraint applies to a WSD callback: its capacity should be checked
before use and failure must not jump through active Rust frames.

The final combined `.mpy` must retain the GC roots for its code, BSS, and
callback objects while any SQLite connection or Rust state exists. Only use
Badgeware's existing filesystem ownership; no raw flash or LittleFS mount
code from the standalone prototype belongs in this module.
