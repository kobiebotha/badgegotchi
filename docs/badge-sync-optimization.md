# Badge sync optimization candidate

The owner authorized rollout on October 20, 2026. The compact projection migration
and PowerSync stream are live; sync config version 6 is active with healthy
replication and no sync errors. Live projection payloads decreased from 1743 to 1231 bytes across
two accounts, with canonical data and privileges preserved.

The first alpha.7 hardware check caught a validation mismatch: real PUT bodies
include the selected `id` field. Alpha.8 accepts it only when it matches the
record id, and all 129 badge tests pass with actual service-shaped fixtures.
Alpha.8 is installed and verified on the badge, preserving all 167 unrelated
files and retaining backups. Two live covering-checkpoint syncs passed with
schema 5, unchanged pairing, empty queues/outbox, clean integrity, and 43 database
pages. The first download replaced the old rows and reduced actual badge payloads
from 928 to 655 bytes (29.4%). Reopening reused the exact persisted cursor and
downloaded no data. The drive was safely ejected. Runtime app storage is read-only,
so the earlier serial patch attempts made no filesystem changes. See
[rollout evidence](../badge/evidence/sync-alpha8.json).

The badge already receives only three current `badge_projection` records. The
browser history streams, including their audit timestamps, cannot be subscribed
to with a badge JWT. Removing browser columns would not reduce badge downloads.

## Smaller projection and client schema

`compact_badge_projection` removes unused pet `updated_at` and `error`, the four
completed/stopped subtotals and `last_hydration_at` from the daily summary, and
`last_command_id` from the timer projection. Backend audit history and command
receipts remain available to the services that use them. Timer revisions and
transition timestamps remain because they control offline replay and elapsed
time. Pet event id and status remain for browser progress and retry handling.

The new explicit `badge_projection_compact` stream selects `kind AS id, payload`.
Owner filtering still uses signed JWT claims before producing the short ids.
The original badge stream remains available for older installed apps. Browser
streams and their schema are unchanged.

Schema 5 removes the redundant `kind` client column. Upgrading preserves the
account binding, cached projection, native checkpoints, and private command
queue. Cached `owner:kind` ids remain readable offline. On the first covering
compact-stream checkpoint, the core removes the old bucket and its long ids as
it publishes the short ids. No database reset or full-account history download
is used.

## Fewer durable transactions

Previously each downloaded operation committed separately with FULL
synchronization and a DELETE journal. Consecutive data records now accumulate
in RAM, bounded by six operations and 8192 bytes. The entire batch is validated
before the first native call, then passed to the real core in order within one
transaction. A native error rolls back the whole batch.

The supervisor flushes before checkpoint/control records, on network idle/clean
EOF, at the size limits, or after 100 ms of foreground elapsed time. There is no
open transaction during socket reads. A disconnect discards uncommitted RAM
records; the core's persisted cursor makes the server replay them. No historical
operations are skipped or collapsed, since the core needs their checksums.

## Host measurements

The saved verified alpha.5 snapshot has 975 bytes of projection payloads; removing
the unused fields reduces that to 702 bytes (28%). Including row ids, the separate
kind fields, and JSON escaping, the three row objects shrink from 1308 to 857
UTF-8 bytes (34.5%). This measures row JSON, excluding wire envelopes and SQLite
page overhead. The synthetic PostgreSQL fixture independently measures payloads
at 807 to 568 bytes.

The real-core 28-operation fixture uses 30 download commits with separate writes
and 7 with batching (76.7% fewer), including checkpoint markers. Both runs
process the same 6412 bytes of data records, publish the same final projection,
and retain identical bucket checkpoints in 37-page databases. Batching saves
durable writes; it does not remove required oplog operations or prove a badge
wall-clock speedup. The parser still handles one operation per foreground frame;
a bounded flush can commit six records together.

On the installed alpha.8 badge, first download took 21302 ms, and the next
connection reused its saved cursor with no downloaded data in 12980 ms. Both
published covering checkpoints, retained the same paused timer and counters,
and passed integrity checks. These are observed timings with authentication and
TLS setup; there is no comparable pre-change device timing baseline. The core's
raw row retains its required `id` alongside `payload`; the visible schema has
`id,payload` and no redundant `kind` column.

## Verification and rollout order

Host tests exercise the actual pinned PowerSync 0.5.4 core, schema 4 to 5
migration, offline cache preservation, replacement of old row ids, checkpoint
visibility, batching limits, rollback, and reconnect behavior. The policy test
compiles the actual YAML with the service evaluator and checks owner isolation
and badge/browser scope boundaries. PostgreSQL/WASM tests execute the migration
and verify payload shape, counters, timer behavior, and audit-only no-op updates.
These checks do not measure badge wall-clock latency or qualify power-loss
recovery on LittleFS.

```sh
python3 -m unittest discover -s badge/tests -v
node powersync/tests/badge-streams.mjs
# Pass the installed PGlite dist/index.js path used by the existing SQL runner.
node supabase/tests/run-account-commands.mjs "$PGLITE_MODULE"
cd web
npm test
```

The policy check uses the local service build selected by
`POWERSYNC_SERVICE_SOURCE`. Authenticated CLI validation against the target
instance remains a rollout check; local policy compilation is not live-service
validation. The compact client explicitly unsubscribes the original persisted
badge stream before starting, so an unexpired legacy subscription cannot request
both sets of rows during an upgrade.

The following sequence is complete; keep it as the order for subsequent rollouts.

1. Apply the additive `compact_badge_projection` migration to the approved
   Supabase target. It also refreshes existing projections.
2. Validate and deploy only `powersync/sync-config.yaml` to the approved PowerSync
   instance. Confirm `badge_projection_compact` is active. The existing CLI link
   names instance `6ad76c8f2f27853eb0b0a128`; deployment requires target approval.
3. Package a new app version, qualify it on the badge, and verify the persisted
   account binding, queue, checkpoint, timer transitions, and web/badge roundtrip.
   Do not install this source candidate against a service without the new stream.
4. Stage the qualified release for the installer. Any Vercel deployment to the
   PowerSync organization requires the owner's approval.

Keep both stream versions while old apps remain installed. Downgrading the app
after schema 5 migration is unsupported. No Git push or Vercel deployment has
been performed.
