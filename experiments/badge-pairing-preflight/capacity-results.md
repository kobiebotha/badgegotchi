# Host-only PowerSync capacity preflight

2026-10-20. These are measured host fixture results, not device qualification,
real service streaming, or a recommendation to deploy the alternative schema.
Only fresh files inside `/tmp/badge-pairing-preflight` were written. No real app,
backup, device, firmware, cloud configuration, or service record was modified.

## Method and evidence

`capacity_fixture.py` imports the existing test `HostCore`, loading the existing
`experiments/badgeware-native/powersync-audit/build/fixture-host.dylib` with
SHA-256 `93f9db4e4d4232444be07657fe18b7f9b27210fa52ba255e84c536583b347c98`.
The library reports SQLite 3.54.1 and PowerSync `0.5.4/cratesio`. It uses the real
core and a 256KiB shared SQLite/Rust arena, a POSIX host VFS, 1024-byte pages,
`max_page_count=128`, cache 8 pages, memory temp store, FULL synchronous and DELETE
journal, matching the app's resource profile except for VFS/architecture/runtime.
The query adapter rejects outputs beyond the badge's 32-row cap.

Every subprocess had a 25-second timeout because the pinned no_std core has a
looping panic handler. Logs are JSON lines followed by traces on failure. The
script refuses to overwrite an existing fixture DB. Retained DBs are synthetic.
No code was compiled or native artifact changed.

The checkpoint payload is deliberately synthetic: one bucket, 11 PUT rows,
checksums of 1 and cumulative arithmetic checkpoint validation. The real core
publishes it through `powersync_control(start/line_text)` and reports
`DidCompleteSync`. This proves processing of this mock fixture only; it is NOT a
service checkpoint, backend readiness, or product sync acceptance.

Payload bounds used: one pet (name 32 bytes, bio 160, speech 240, error 80), one
current session (UUID, UTC stamps, full timer fields plus revision), one daily
count projection, and eight fixed activity slots (36-byte event UUID, UTC stamp,
48-byte label). Strings are ASCII at those byte bounds; production would need
enforced byte/encoding/wire limits. One local-only table preserves synthetic
legacy state, identity metadata, and an exact captured first-upload payload with
retry digest (878 bytes). No real credentials were generated or read.

## Ordinary-column candidate: blocker before first sync

- `canonical` uses seven tables: legacy metadata; sessions, wellness events,
  pet sessions, pet events, authoritative daily totals, eight recent slots.
  `powersync_replace_schema` fails with **out of memory** before inserting data.
  Recorded arena high-water is **257,152 bytes** (of 262,144); DB transaction
  rolls back to zero bytes.
- `projection_only` removes wellness and pet-event outbox tables, leaving five
  tables (legacy + the four projections). The same schema-creation operation
  fails with **out of memory**, high-water **257,408 bytes**, before rows.

Evidence: `capacity-canonical.jsonl`, `capacity-projection_only.jsonl`. This is a
specific failure of the tested normal PowerSync per-column schema creation path,
not proof that every schema shape, migration strategy, or raw-table adapter fails.
It is enough to reject assuming a small row count alone makes the current web
schema fit the badge arena. It does not establish a need to change firmware.

## Compact experimental alternative

For sizing only, three tables replace the per-column shape: local-only
`badge_state(snapshot)`, downloaded `badge_projection(kind,payload)`, and outgoing
`badge_commands(command_id,kind,payload,created_at,expected_revision)`. Each command
is an explicit canonical activity intention; it is not the legacy aggregate
snapshot written into web tables. A real gateway would validate and apply it to
canonical sessions/wellness plus independently queued pet work. The alternative
needs a reviewed server projection contract and trusted stream authorization.

| Host stage | DB bytes | Pages | Shared arena peak |
| --- | ---: | ---: | ---: |
| Three-table schema, no data | 45,056 | 44 | 184,000 |
| Initial 11-row completed mock checkpoint + local metadata | 55,296 | 54 | 188,416 |
| 100 full replacements of the same 11 projection ids | 57,344 | 56 | 193,856 |
| Eight offline commands after churn | 64,512 | 63 | 196,032 |
| Eight commands + persisted first transaction capture | 65,536 | 64 | 196,032 |
| 16 pending commands + capture | 73,728 | 72 | 196,096 |
| 32 pending commands + capture | 94,208 | 92 | 196,096 |

`compact_safe` stops at 32 commands, closes and reopens. All **32 ps_crud rows**,
**11 ps_oplog rows**, and `integrity_check=ok` survive. No queue acknowledgments
were simulated. Each command contains one hydration action and associated pet
intent identity; actual gateway atomicity/receipt handling was not implemented.

The largest synthetic line was **1112 bytes**, largest SQL **1152 bytes**. Sampled
journal maximum for this completed run was **16,920 bytes**, measured after SQL
statements while transactions were still open. Sampling is not a guarantee of
the instantaneous maximum, filesystem atomicity, or worst-case rollback size.

At 32 commands the DB has **36KiB** below its cap and the observed arena has
**64.5KiB** below its cap. Neither includes Python, TLS/socket, display, token,
framing buffers, or filesystem reserve. Current Store reserve formula requires
64KiB + DB size + 8KiB still free before a save: at 94,208-byte DB that is **164KiB
free**, beyond the database itself. Measure the actual shared state partition.

## Full-capacity behavior: reproducible host crash needs investigation

A no-churn run (`compact_boundary`) accepted 66 commands at 128 pages. The 67th
command returned `database or disk is full`; the 66 pending entries and integrity
survived close/reopen. Log: `capacity-compact_boundary.jsonl`.

After 100 projection checkpoints, however, the process **segfaulted during the
65th command INSERT**, with 64 commands previously committed and a 130,048-byte
(127-page) database. This occurred twice: `capacity-compact_churn.jsonl`, then
`capacity-compact_churn_repro.jsonl` with faulthandler and exact last SQL. The
C stack includes PowerSync `crud_vtab::update` / `Statement::exec` and
`sqlite3_step`. Exact operation is retained in
`capacity-compact_churn_repro-last-sql.txt`. The crash DB is retained unchanged;
no recovery/repair was attempted. The root cause is not yet established.

This is an unresolved host native-integration full-capacity failure that blocks
qualifying the workload, distinct from the known device inability to
truncate/recover a hot journal. It is not proof that the installed badge crashes. Do not qualify
unbounded queue growth or rely solely on catching SQLITE_FULL. A provisional
32-command admission limit leaves room in this one payload profile, but is not
proof for arbitrary command sizes, TLS memory, interrupts, or power loss. Before
real device sync, enforce both count and byte budgets, preserve pending work,
show a storage-full resolution state, and investigate/qualify the boundary.

## Read-only crash attribution follow-up

Inspection of the preserved trace, host shim, ctypes adapter, pinned Rust source,
and existing dylib disassembly supports a native SQLite/PowerSync error-path
failure, not a Python assertion or result-marshaling failure. The host shim only
registers `powersync_init_static`; its panic personality calls `abort` (SIGABRT),
whereas this failure is SIGSEGV. The Python frame is still inside `sqlite3_exec`
(`badge/tests/test_storage.py:205`), before its return-code conversion at line206.
The failing statement is an INSERT without returned rows, and no Python result
callback/error-conversion frame appears in the stack. These observations do not
rule out every host ABI/build interaction.

The core stack's `crud_vtab::update+0x3dc` resolves to the call of `Statement::exec`
for the cached `INSERT INTO ps_crud(tx_id,data)` statement (pinned core
`crates/core/src/crud_vtab.rs:158-179,254-258`). The symbolized
`sqlite3_step+0x2e4` is the return site of `sqlite3VdbeTransferError` in this dylib.
The inner `sqlite3_step` has not returned to Rust, so **no exact Rust/Python error
conversion or returned SQLite error code can be attributed to this crashing
run**. In particular, FULL is a recognized enum value (`sqlite_nostd/src/nostd.rs:74`),
so treating it as an unknown-code `.unwrap()` panic is unsupported. The clean
no-churn run's SQLITE_FULL is a separate observed result, not the crashed call's
captured return value.

A concrete source-level hypothesis is reentrant statement lifetime invalidation:
SQLite's `sqlite3VdbeHalt` may call `sqlite3RollbackAll` for FULL/NOMEM/IOERR; that
calls virtual-table `xRollback` (`sqlite3.c:90840-90880,189892`). PowerSync's
`rollback` calls `end_transaction`, which takes/drops `current_tx` and its cached
statements (`crud_vtab.rs:228-233,361-365`). `ManagedStmt::drop` finalizes its SQLite
statement (`sqlite_nostd/src/nostd.rs:547-550`). If that callback occurs during the
cached statement's own step, the statement and Rust borrow can be invalidated
before error transfer finishes. This mechanism is consistent with the preserved
stack and missing journal after automatic cleanup, but remains **a hypothesis**:
there is no recorded rollback breakpoint, register/core dump, sanitizer trace,
or instrumented call-order proof. Do not label it a confirmed upstream bug or
badge failure. A separate instrumented host reproducer would be the appropriate
next investigation. No stress rerun, DB access, native edit, or firmware change
was made for this attribution follow-up.

## Limits and next tests

- POSIX permits truncation; Badgeware's VFS deliberately rejects it. The fixture
  did not substitute the device VFS and cannot qualify rollback, shrink, flash
  power-loss behavior, or directory/credential-write atomicity.
- Initial schema used a fresh isolated DB. It did not migrate or modify the
  actual v2 device DB; migration memory and retained legacy footprints need a
  separate copied-database test once the final schema is chosen.
- Core handled actual superseding PUT/deletion work over 100 checkpoints while
  storage remained bounded, without VACUUM. There was no real service, stream
  subscription, auth token, gateway request, or checkpoint upload/echo cycle.
- All data must be bounded server-side. This experiment does not make today's
  full-history auto-subscriptions safe or validate stream syntax.
- The four normal projection tables failed schema creation; compact payload
  projections are one investigatory option. Raw tables, narrower fields, or
  other supported core adapters could be evaluated without firmware replacement.
