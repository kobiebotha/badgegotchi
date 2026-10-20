# Badge pairing and PowerSync preflight — 2026-10-20

This completes the first preflight pass requested by
[the handoff](../../docs/handoffs/badge-pairing-powersync.md). It does **not**
implement pairing, issue device credentials, change the installed app, or prove
live sync. The preflight found gates that must be resolved before enabling
credential enrollment or connecting the installed app to PowerSync.

## Results

| Check | Result |
| --- | --- |
| Existing cloud target | Supabase `bfccerfayrfolisawokp`; PowerSync instance `6ad76c8f2f27853eb0b0a128`, project `6ad76c8e02e1e50007a3552a`, label `Production`. Existing README records owner classification as development. No deployment authorization inferred. |
| Live replication | Connected; active config version `3`; initial replication complete; zero reported lag; no reported errors. |
| Current cloud data | One owner with 14 rows: 2 sessions, 2 wellness events, 1 pet session, 9 pet events, 0 summaries. Aggregate PostgreSQL logical row size 3,791 bytes; this is not SQLite, index, queue or checkpoint cost. |
| Installed runtime | Tufty 2350, MicroPython 1.29.0, exact `bw-1.29.0-gc` build dated 2026-09-22, `_mpy=7942`; unchanged. |
| Owned database | 33,792 bytes, schema v2, 33 × 1024-byte pages, integrity OK, empty `ps_crud`. Host backup made before inspection; no migration performed. Before/after copies are byte-identical. |
| Shared storage | 69 × 4096 = 282,624 bytes free (276 KiB). DB theoretical headroom is 95 KiB; journal/shared reserve and native memory impose additional constraints. |
| Supabase HTTPS | Explicit CA + `CERT_REQUIRED`, real hostname, credential-free GET `/` returns 404. TLS 1.2 `TLS-ECDHE-ECDSA-WITH-AES-128-GCM-SHA256`. Reconnect passed. |
| PowerSync HTTPS | Existing CA bundle correctly rejects the chain. Adding the public Sectigo R46 root **in RAM only** allows credential-free GET `/`, 404, TLS 1.2 `TLS-ECDHE-RSA-WITH-AES-128-GCM-SHA256`. |
| Certificate negatives | Wrong expected hostname rejected; no CA rejected with `MBEDTLS_ERR_SSL_CA_CHAIN_REQUIRED`; `expired.badssl.com` rejected specifically for expiry. RTC was not changed. |
| Cooperative networking | Installed stepped DNS and nonblocking TCP/TLS exercised. Pending TLS operation cancelled, socket closed, subsequent Supabase connection succeeded. This is simulated diagnostic cancellation, not a physical Home test of a syncing app. |
| Responsiveness | Maximum observed individual DNS/TLS step 923 ms in successful probes; PowerSync successful run 316 ms. No combined native-core/TLS/display measurement or physical Home-latency qualification. |
| Stream policy | 23 local compiler/bucket-evaluator checks passed, including owner/issuer/scope isolation, forged client parameters, explicit history requests, eight-slot bounds and 1,000 extra history rows. Not deployed-service/JWT-signature tests. |
| Capacity | Ordinary five-table projection schema fails with OOM before rows. Compact three-table experiment holds 11 rows + 32 commands after 100 checkpoints at 92 KiB DB and 196,096-byte arena peak, then reopens intact. Host-only synthetic protocol fixture. |
| Capacity failure | With checkpoint churn and a near-full DB, command 65 reproducibly crashes the host process. Do not repeat this stress test on the badge or claim safe overflow handling. |
| Preservation | 210 hashed app/asset/library files match the previous alpha.2 inventory. No files added/removed; only normal `/state/loading.log` metadata changed. Settings/state were compared by metadata, not secret contents. |

The initial weak Wi-Fi signal (~−90 dBm) caused DNS/TCP failures and disconnection.
After the user moved the badge, it reconnected and the successful TLS probes above
ran at about −80 to −87 dBm. Earlier failures are retained; deadlines and retry UX
remain necessary. No Wi-Fi credentials were read, printed, replaced or provisioned.

## Gates before enrollment and real sync

1. **Credential entropy and clock policy.** The installed `ssl` compatibility
   wrapper defaults to `CERT_NONE`; the tests override and assert required
   verification. More significantly, the source randomness path reaches Pico
   SDK `get_rand_64`, which mixes raw TRNG samples through a general-purpose PRNG.
   The exact firmware build configuration/entropy assurance is not established.
   Working `os.urandom(32)` is not proof of two independent 256-bit credentials.
   Qualify this path or a supported app-level cryptographic source before
   enrollment. The RTC was plausible and expiry enforcement passed, but unset,
   backward and boot-time trust policies remain unqualified. See
   [source audit](network-source-audit.md). These findings do not justify replacing
   firmware.
2. **Memory and overflow safety.** Five ordinary-column tables exhaust the
   256 KiB native arena at `powersync_replace_schema`. The compact representation
   is a measured option, not a finalized client schema. Investigate the reproduced
   full-database host crash, enforce both byte and count admission limits, and
   qualify the chosen representation/migration on a disposable owned device DB.
   See [capacity report](capacity-results.md). Do not use an arbitrary 32-command
   limit as proof for every payload or flash failure.
3. **Persistence.** The actual VFS refuses truncation and retains nonempty startup
   journals. Host POSIX tests cannot qualify hot-journal recovery, replicated
   deletion/rollback, interrupted private credential writes or power loss. Preserve
   all suspect data and existing local progress; do not add VACUUM/repair/raw-flash
   workarounds.
4. **Backend readiness for badges.** Browser replication works, but no device
   gateway, private pairing schema, bounded projections, durable upload receipts,
   common timer command gateway or asynchronous pet retry worker exists. The
   [backend contract](backend-contracts.md) records the proposed service-auth and
   stream changes for later review; it is not an executable deployment diff or
   permission to deploy. Complete implementation/tests and review the exact target
   diff before cloud mutation.
5. **App lifecycle.** Add explicit CA trust for the PowerSync endpoint, bound
   network steps/framing/outbox, and measure TLS/core/UI together. A successful
   HTTPS 404 means the server was reached with verified TLS, not authentication or
   a completed sync checkpoint. No badge↔web round trip has passed.

## Decisions prepared for implementation

[Data contracts](data-contracts.md) specify canonical sessions/wellness, first
accepted timer start wins, versioned transitions for **both** web and badge,
server-derived reaction identity, authoritative complete/stopped totals,
owner-bound outboxes, reset tombstones and explicit legacy/timer adoption.
Legacy aggregates remain visibly pre-pairing progress; no invented history.

[Backend contracts](backend-contracts.md) specify exact pending-claim approval,
recoverable pre-persisted credentials, revocation/rotation, private server-only
records and atomic captured-transaction acceptance. Browser streams require the
exact Supabase issuer and absence of badge scope; badge streams require the
exact dedicated issuer, trusted scope/device claim and owner filter. Client
parameters cannot expand access. The candidate projection constraint is 11
logical rows; database constraints, text byte limits and the final compact client
mapping must still be implemented.

Next implementation should resolve the native capacity/entropy/persistence gates,
then implement/test backend pairing and common data commands locally. Only after
backend readiness and reviewed cloud auth/stream changes should the real badge
client be connected. Keep the current offline alpha.2 install working meanwhile.

## Reproduce without touching a device or cloud

The local PowerSync service source must already be built. Override its location
with `POWERSYNC_SERVICE_SOURCE` if needed:

```sh
node experiments/badge-pairing-preflight/check-streams.mjs
```

Capacity tests reuse the existing pinned host core. They create synthetic files
in a fresh temporary directory by default and refuse to overwrite a fixture DB:

```sh
python3 experiments/badge-pairing-preflight/capacity_fixture.py compact_safe
python3 experiments/badge-pairing-preflight/capacity_fixture.py projection_only
```

`projection_only` is expected to fail with OOM. Run native experiments in a
subprocess with a deadline: the no-std panic handler may loop. The boundary/churn
modes intentionally approach a native crash and require `--allow-native-crash`;
inspect the retained evidence before running them. No stress processes remain
running. The macOS Python crash dialogs observed during this task came from these
host native tests; the installed badge was not running the stress fixture. **These are host-only scripts, never device scripts.**

Existing regression checks:

```sh
python3 -B -m unittest discover -s badge/tests -v
cd web
npm test -- --configLoader runner --no-cache tests/domain.test.ts tests/connector.test.ts tests/connector.database.test.ts
```

## Device probes and evidence

`device_capabilities.py` inventories runtime/API names and free space only.
`device_tls_probe.py` reuses existing connected Wi-Fi, installed CA roots and
installed `bounded_dns`; it makes only credential-free public GET requests. It
prints HTTP status/cipher/timing, never bodies or credentials. No device files are
written. It is diagnostic code, not an app transport, and does not install a Home
handler. It can temporarily interrupt the current foreground app via `mpremote`.
Use only after saving/exiting an app and return normally to the launcher after
probing. Wi-Fi configuration is not changed.

Run through the already-installed `mpremote` tool with `connect PORT resume run
SCRIPT`. Native `tls.load_verify_locations` accepts DER bytes positionally; the
initial probe incorrectly used the Python `ssl` keyword form, failed before TLS,
and was corrected. Earlier blocking-DNS diagnostics are retained as evidence,
not the recommended implementation.

The extra-CA and expiry scripts embed **public CA DER bytes** into host-generated
scripts and pass them into badge RAM. They do not install roots on the badge.
Root provenance/hashes are under `evidence/`; the long-lived production trust
bundle and update policy still need review. Installed public networking `.mpy`
files were copied to the host for inspection only and are not redistributed here.

Evidence logs deliberately distinguish successful probes, expected certificate
rejections, network failures, synthetic host checkpoints and unresolved gates.
The private byte-identical before/after database copies live under ignored
`badge/dist/backups/`; no database or credentials are in this experiment's tracked
files. The final normal reset disconnected the USB console as expected; a manual
physical launcher/Home recheck is still not claimed.

No app/native binary, package, web UI, database schema or cloud configuration was
changed. No deployment, Git staging, commit or push was performed.
