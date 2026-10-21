# Badge pairing: cloud activation review

Updated October 20, 2026. The owner approved activation on the exact development
targets below. This document records completed work and the remaining ordered
gates; do not rerun completed mutations merely because their commands are shown.

## Current installed update — alpha.8 compact sync verified

The approved compact-projection migration `20261021004457` is deployed to
Supabase `bfccerfayrfolisawokp`. PowerSync instance
`6ad76c8f2f27853eb0b0a128` runs stream configuration version **6**, including
the guarded explicit `badge_projection_compact` stream. Replication was healthy
with zero lag at postflight. Six current projection payloads across two accounts
decreased from **1743 to 1231 bytes**; canonical-data fingerprints and service-only
refresh privileges were preserved. The original badge stream remains available
for older apps.

The checked USB updater installed
`badge/dist/badgegotchi-0.1.0-alpha.8-b6363dde0d08.zip`, SHA-256
`b6363dde0d0846f6ac8a0f076710907a1cb644f7f4455473297fde8f32ff7b2d`:
718,973 ZIP bytes, 58 files, 1,237,894 installed bytes. It preserved all **167
unrelated file hashes**, the existing pairing and account binding. The native
module and firmware are unchanged; prior app and pre-migration schema-4 database
backups are retained.

The installed supervisor completed two covering checkpoints. The first replaced
the three cached long row ids with `pet`, `summary`, and `timer`, reducing badge
projection payloads from **928 to 655 bytes**. Three PUTs totaling 1841 data-record
bytes used two batch flushes, with at most two records in a flush. Sync took
21,302 ms; reopening reused the same persisted cursor, downloaded no data
records, and synced in 12,980 ms. These measurements do not establish a speedup
without an equivalent pre-change hardware baseline.

Both passes verified schema **5**, the `id,payload` view without `kind`, only
the active explicit compact subscription, fully applied checkpoints, integrity
`ok`, **43 pages**, empty command/legacy/SQL queues, and an unchanged pairing
fingerprint. Raw core rows retain their required matching `id` and `payload`.
Cached totals and timer state were preserved; no account actions were generated.
Alpha.8 fixes the service-generated matching `id` field rejected during the
initial alpha.7 download; all **129 badge tests** pass with service-shaped
fixtures. See [alpha.8 rollout evidence](../badge/evidence/sync-alpha8.json) and
the [optimization record](badge-sync-optimization.md).

Cloud and installed-badge qualification are complete. Public web/installer
publication and the separately reviewed legacy-DML cutover remain distinct work;
no agent Git push or Vercel deployment occurred. The following alpha.6 and
alpha.5 records retain their historical qualification and publication status.

## Historical installed update — alpha.6, UI only

The owner requested removal of `Account YYYY-MM-DD` and related explanatory
caption text. Alpha.6 shows current values directly: the main caption is removed,
details is headed `Totals`, and pending text appears only for a nonzero count.

The checked updater installed
`badge/dist/badgegotchi-0.1.0-alpha.6-cabcbfa4568a.zip`, SHA-256
`cabcbfa4568aff3eb7f959b0476dc42ebb5c28803ee3cbd5449fbf03b85f4efa`:
717,504 ZIP bytes, 58 files, 1,232,547 installed bytes. The ZIP file set is unchanged;
only the view, README, and package metadata differ from alpha.5. All sync,
storage, client, state, native, and asset bytes are identical. The checked update
preserved all 167 unrelated file hashes and preservation tree
`4b02d5229fab4028ddca8d22afb8688be79f4b575ff0924e9679f405df195f74`.
The previous app backup is `badge/dist/backups/app-before-alpha6-20261020` and the
drive was safely ejected. See [alpha.6 evidence](../badge/evidence/display-alpha6.json).

Local public installer staging and app/hash checks pass for alpha.6; 16
command/view, 14 packaging, and 5 updater tests pass. No cloud/database mutation
or fresh database check was part of this UI-only update. Post-update hardware
visual confirmation was **not run**. Prior alpha.5 renderer/shared-state evidence
remains the baseline; geometry is unchanged except fewer text lines, and another
hardware/database test cycle is not required. The owner should press Reset once
and reopen the app normally.

Public web/installer publication and legacy-DML cutover remain pending. The
owner must commit/push; the agent must not push or deploy to Vercel. Verify the
deployed bundle/installer before applying the separately reviewed activation SQL.

## Shared-state backend and alpha.5 qualification — unchanged by alpha.6

The additive [shared-account migration](../supabase/migrations/20261020224246_shared_account_commands.sql)
is deployed on the existing development targets listed below. It adds immutable
command receipts, one account timer revision, atomic command/domain/AI-intent
writes, always-present timer projections, and durable inference retry state.
No canonical account history or saved pairing was reset. The owner authorized
removing old badge-only progress; schema 4 performs that local cleanup.

| Deployed component | Verified status |
| --- | --- |
| `badge-gateway` | ACTIVE, version 3, `verify_jwt=false`; owner Auth/session and opaque badge credential validation remain in the handler |
| `pet-ai` | ACTIVE, version 6, `verify_jwt=true`; existing browser Auth validation preserved |
| `pet-worker` | ACTIVE, version 1, `verify_jwt=false`; separate server-only `PET_WORKER_SECRET`, service-only claim/finish RPCs |
| PowerSync | Active stream version **5**, including guarded browser projections; initial replication complete, no connection/table errors, about 5 KiB lag at postflight |
| Worker schedule | `badgegotchi-pet-worker`, active every minute; last five observed runs succeeded |
| Worker HTTP | Seven responses in the sampled 15-minute window: all HTTP 200, no timeouts |
| Extensions | `pg_cron` 1.6.4, `pg_net` 0.20.4, `supabase_vault` 0.3.1 |

The [transaction-wrapped worker setup](../supabase/operations/schedule-pet-worker.sql)
is installed, including prompt AFTER INSERT wakeups and the independent retry
schedule. Vault names `badgegotchi_pet_worker_url` and
`badgegotchi_pet_worker_secret` exist; no secret values were read in postflight.
Temporary plaintext provisioning material has been cleaned up. Unauthorized
requests to the gateway, pet-ai, and worker each returned HTTP 401. This rollout
retains existing Supabase browser authentication and badge JWKS trust; no new
PowerSync service-auth change was needed.

Read-only database checks verified the migration record, enabled timer-revision,
pet-projection and worker-wakeup triggers, and private-table RLS. Authenticated
clients cannot SELECT/INSERT command receipts or timer heads, and can only SELECT
the owner-filtered public projection. `account_gateway`, `pet_ai_claim_next`,
`pet_ai_claim`, and `pet_ai_finish` are invoker functions executable by the service
role, not anon/authenticated. Each of two account owners has all three projection
slots; the largest pet/summary/timer payloads were 308/289/222 bytes against the
1,536-byte bound. At that initial postflight, all 13 observed pet events were
completed, with no pending work.

The final alpha.5 ZIP SHA-256 is
`6565850affadb108bb3d43fa1056358b9c883969b05533a90de400f9f814dd78`:
717,568 ZIP bytes, 58 files, 1,232,779 installed bytes. It was installed and
qualified before the alpha.6 UI-only replacement; all 167 unrelated file hashes are unchanged. The actual badge
Client passed schema-4, integrity, completed three-row projection checkpoint,
queue-zero, 43-page database, and unchanged pairing-fingerprint checks. Confirmed
initial state was Water 5 / Move 1 / Pets 0 with an idle timer.

The shared-action roundtrip is now verified through the actual browser UI and
**automated input to the installed badge Client's button handlers**, not human
physical presses. Web start produced revision 1, badge pause revision 2, and web
resume revision 3. The subsequent badge water, pet, and stop actions each reached
a real checkpoint (generations 2, 3, and 4 in the final device run), with zero
queued commands and a healthy database. Both clients reported Focus 1 / Break 0 /
Water 6 / Move 1 / Pets 1; the web timer showed 40:00, Focus ready.

Independent read-only SQL found exactly six accepted receipts, one each for
`timer_start`, `timer_pause`, `timer_resume`, `hydration`, `pet`, and `timer_stop`,
with no rejection reasons. All six matching pet intents completed on their first
attempt without errors. Canonical state contains one ended/stopped focus session
and exactly one paused focus successor at revision 4 with 2,400 seconds. No owner
has more than one live timer. Focus 1 means ended/stopped; completed-focus count
is still zero. Browser screenshot:
`/private/tmp/badge-alpha5-web-shared-result.png` (host-only artifact).

Installed-entrypoint UI qualification passed: two healthy frames in 375 ms.
Main/details display bounds passed for all 30 animals and large-count/long-text
fixtures. The [main screen](../badge/evidence/shared-state-alpha5-main.png) and
[details screen](../badge/evidence/shared-state-alpha5-details.png) capture actual
synced account state, not fixtures. See the final
[alpha.5 evidence record](../badge/evidence/shared-state-alpha5.json).

The fresh final checkpoint has three projection rows, one fully applied bucket,
and zero command/legacy-upload/SQL CRUD queues. Database integrity is `ok` at
43 pages / 44,032 bytes. Legacy `current`/`legacy` progress rows are absent; the
single account binding and pairing fingerprint are preserved. The journal is
empty after close. The host database backup matches the device SHA-256
`f5f89970bd87444bf18b04193e2caf81c042574c10491e2a75e738565cf2895e`.
The app was closed and normal machine reset completed with the expected USB
disconnect. Human confirmation of normal launcher/reopen appearance is pending.

Latest local checks passed: 152 web tests, TypeScript and production build;
38 Edge Function tests; and the PostgreSQL/WASM command, CAS, receipt, security,
worker recovery and failed-wakeup transaction suite. No native full-capacity
stress test was run. That exact qualified ZIP was staged in the local public
installer and has since been replaced locally by alpha.6. App checks, 89 installer unit tests, and a fresh production build pass;
public/build manifests and hashes match all 58 files and 30 animal assets. These
artifacts are ready for owner publication, not yet verified on the deployed site.

**Deferred activation:**
[activate-shared-commands.sql](../supabase/operations/activate-shared-commands.sql)
has deliberately **not** been applied. Authenticated direct session/wellness DML
remains enabled until the owner publishes the new web bundle. The additive
migration advances the shared revision for legacy timer mutations during this
transition. After new clients are available, the separate activation transaction
checks for ambiguous timers, revokes old direct writes, and adds the one-live-timer
constraint. Do not apply it merely because this document lists it.

Remaining sequence: tell the owner to press Reset once and reopen alpha.6,
have the owner commit/push the prepared web and installer changes,
verify the deployed bundle and installer hashes, then perform the separately
reviewed direct-DML cutover. The agent has performed no Git push or Vercel
deployment and must not do either. No new pairing is needed. Public ingress limits, real
concurrent-transaction testing, radio-loss/token-expiry/revocation timing and
power-loss/capacity recovery remain separate gates.

## Historical pairing activation status — alpha.3/alpha.4

The following records the earlier pairing rollout and its then-current versions,
counts and installer state. The current alpha.6 status and retained alpha.5 qualification above take precedence.


- Applied and verified `20261020204932_badge_pairing_gateway`.
- Applied `20261020214705_badge_projection_replication_grant` after the PowerSync
  CLI caught missing snapshot `SELECT` permission for the configured role
  `powersync_d946af30634391c2381c8473`.
- Provisioned the five new `BADGE_*` values and deployed only `badge-gateway`.
- Live public checks passed: JWKS HTTP 200 with the exact public-field allowlist;
  unauthenticated owner creation, invalid-Bearer owner creation, and an unregistered
  random candidate's token request each returned HTTP 401 without a token.
  These negative checks created no pairing sessions or account tokens.
- Guarded streams are deployed and active as version 4. The remote stream document
  exactly matches the reviewed local configuration. All six published source
  tables are healthy, initial replication is complete, and final lag was zero.
- Badge JWKS trust is enabled. A correctly signed short-lived token for a random
  test identity was rejected with HTTP 401 before trust, then accepted with HTTP
  200 and an empty badge-projection checkpoint afterward. The final remote service
  configuration differs only by the approved JWKS URL; Supabase auth, existing
  inline JWKS, connection metadata, secret references, and region are preserved.
- Alpha.3 was installed through the checked updater, with old-app backups on the
  host and badge and a fresh byte-verified v2 state backup before first launch.
  See [installation evidence](../badge/evidence/installation-alpha3.json).
- The owner signed in at http://127.0.0.1:5174/; the browser showed All connected,
  loaded the live empty badge list, and generated a pairing code successfully.
  The owner entered the physical A/B/C sequence, matched verification ID
  `04E9-0870`, and approved it. The registration is delivered/active and its
  private credential survives resets. Alpha.3 then exposed two stream bugs: null
  connection parameters and oversized history batches. Alpha.4 fixes both; its
  source completed a real checkpoint in memory on the badge with two projection
  rows, empty queues, and an intact 38 KiB database. Alpha.4 is now installed
  through the checked updater, with both app backups and all 167 unrelated
  file hashes preserved. Its saved pairing fingerprint is unchanged. Normal
  launch and Home/reopen both reached SYNCED without another code. Two intended
  C presses produced exactly two canonical water events and two receipts, visible
  in the web app. One explicitly approved web movement event reached the badge;
  both showed Water 2 / Move 1 with zero queued uploads. Final persisted checks
  found one fully applied bucket, a healthy 40 KiB DB, no SQL CRUD or in-flight
  upload, and the exact retained legacy snapshot. A final DB backup is saved.
  Live revocation timing and the additional resilience gates below remain open.
  See [sync-fix evidence](../badge/evidence/sync-fix-alpha4.json).
- The agent performed no Vercel deployment or Git push. The owner reported a
  Vercel push; the last read-only check still found GitHub/Vercel at e432e57,
  before the local 9ba34a5 pairing implementation.
- Server secrets were backed up and read-verified through the native macOS
  Security API under service `Badgegotchi gateway`, account
  `bfccerfayrfolisawokp/badge-20261020-v1`. No secret values were printed.
  The temporary plaintext provisioning file was removed after signer verification.

## Targets and scope

| Resource | Exact target |
| --- | --- |
| Supabase | `bfccerfayrfolisawokp` — `https://bfccerfayrfolisawokp.supabase.co` |
| PowerSync Cloud instance | `6ad76c8f2f27853eb0b0a128` |
| PowerSync project | `6ad76c8e02e1e50007a3552a` |
| PowerSync endpoint / custom JWT audience | `https://6ad76c8f2f27853eb0b0a128.powersync.journeyapps.com` |
| Badge issuer | `https://bfccerfayrfolisawokp.supabase.co/functions/v1/badge-gateway` |
| Public badge JWKS | `https://bfccerfayrfolisawokp.supabase.co/functions/v1/badge-gateway/jwks` |
| Dedicated pet worker | `https://bfccerfayrfolisawokp.supabase.co/functions/v1/pet-worker` |

The instance is labeled **Production**, but the owner recorded it as a development
target in the repository. The owner has now approved the specific activation
steps recorded here. Verify [the link](../powersync/cli.yaml) still matches before
any remaining mutation. No Vercel deployment or Git push is included.

Historical pairing activation scope (already completed):

- [The pairing migration](../supabase/migrations/20261020204932_badge_pairing_gateway.sql): private pairing/device/credential/receipt tables, atomic RPCs, and the bounded public projection. Existing source history is preserved.
- [The replication-read grant](../supabase/migrations/20261020214705_badge_projection_replication_grant.sql): only `SELECT` on `public.badge_projection` for the existing named PowerSync role; no writes or private-table access.
- [The badge gateway](../supabase/functions/badge-gateway/index.ts) and its server-only configuration.
- [The scoped streams](../powersync/sync-config.yaml): existing five browser streams plus the explicit `badge_projection` stream.
- This one-line addition to the existing PowerSync `client_auth` block, preserving every replication, region, credential reference, and existing auth setting:

```diff
 client_auth:
   supabase: true
+  jwks_uri: https://bfccerfayrfolisawokp.supabase.co/functions/v1/badge-gateway/jwks
```

Keep the Supabase browser collector enabled. Local service source
`packages/service-core/src/util/config/compound-config-collector.ts` adds remote
JWKS collectors and then independently adds Supabase's collector when `supabase`
is true; Supabase keys retain their `authenticated` audience behavior. The badge
signer uses the full Cloud instance URL as its audience, matching the
[Cloud custom-auth requirement](https://docs.powersync.com/configuration/auth/custom#jwt-requirements).
Local `auth/KeyStore.ts` compares audience values exactly. Use no trailing slash;
no additional audience setting is needed for this standard Cloud URL. The live
service accepted that exact audience with the badge signer during activation.

## Historical pairing activation order and qualification gates

Run from `/Users/kobie/projects/powersync/skunkworks/badgegotchi`. The installed
Supabase CLI help and PowerSync CLI `0.10.2` help were inspected for these flags.
Keep credentials in their existing CLI authentication stores or private env
files, never in command arguments or logged output. Stop on a failed check.

1. **Check the targets and pending migration — completed for this activation.** Save the current remote service
   and stream configuration privately for comparison/rollback, using `fetch
   config`, which does not overwrite local files. Do not use `pull instance`
   against this edited checkout.

```sh
BADGE_CONFIG_BEFORE=$(mktemp /private/tmp/badge-pairing-config.XXXXXX)
npx --yes powersync@0.10.2 fetch config --instance-id=6ad76c8f2f27853eb0b0a128 --output=json > "$BADGE_CONFIG_BEFORE"
npx --yes powersync@0.10.2 status --instance-id=6ad76c8f2f27853eb0b0a128 --output=json
supabase db push --project-ref bfccerfayrfolisawokp --skip-vault --dry-run
```

   The first dry run identified the intended pairing migration. A later dry run
   separately reviewed the replication-read grant. Both are now applied. Before
   any future retry, accept only explicitly reviewed pending migrations; resolve
   unexpected history or target drift before writing.

2. **Apply the schema, then verify publication and privileges — completed.** The migration
   rejects an existing `FOR ALL TABLES` PowerSync publication. Only
   `public.badge_projection` is added; no private table may be replicated.

```sh
supabase db push --project-ref bfccerfayrfolisawokp --skip-vault
```

   Check the created tables/RPC grants, projection maximum of three rows per
   owner and 1,536 bytes per payload, source row preservation, and publication
   membership using read-only SQL. The initial check passed; CLI stream validation
   then exposed the missing replication-role `SELECT`, corrected by the second
   migration. Its grant is table-specific and does not alter RLS or role attributes.
   The existing role was confirmed to have `BYPASSRLS` and `REPLICATION` without
   superuser. Snapshot reads rely on that existing capability; granting
   `REPLICATION` alone would not provide it. No browser role or private-table
   privilege was expanded. Do not run fixture-writing SQL tests on the shared cloud
   database.

3. **Provision server-only configuration and deploy only the new gateway — completed.**
   Prepare `/private/tmp/badge-gateway-secrets.env` with mode `0600`, containing
   fresh cryptographic material and these exact names:

| Name | Value / requirement |
| --- | --- |
| `BADGE_HMAC_KEY` | 32 random bytes as 64 lowercase hex characters; keep stable after pairing |
| `BADGE_SIGNING_JWK` | Private EC P-256 JWK JSON including `d`; never return or log it |
| `BADGE_SIGNING_KID` | A unique key ID, e.g. `badge-20261020-v1` |
| `BADGE_POWERSYNC_URL` | `https://6ad76c8f2f27853eb0b0a128.powersync.journeyapps.com` |
| `BADGE_POWERSYNC_AUDIENCE` | The identical URL above |

   Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; do not replace
   those or existing OpenAI secrets. Never use `VITE_*` variables for these values.
   Retain the HMAC key and private signing key in secure operator storage; remove
   the temporary env file after provisioning and verification.

```sh
supabase secrets set --project-ref bfccerfayrfolisawokp --env-file /private/tmp/badge-gateway-secrets.env
supabase functions deploy badge-gateway --project-ref bfccerfayrfolisawokp --use-api --no-verify-jwt
```

   This function deliberately performs its own owner Auth/session and opaque
   device-credential checks. Its public claim and JWKS routes cannot use the
   platform Supabase-JWT check. Existing `pet-ai` keeps `verify_jwt=true` and is
   not redeployed. Verify the public JWKS contains only `kty,crv,x,y,kid,alg,use`,
   invalid owner credentials fail, and candidate credentials fail before approval.
   At this point PowerSync must still reject the new badge signing key.

4. **Deploy the stream guards before trusting the badge key — completed.** All five browser
   streams require the Supabase issuer and no `badge_scope`. The badge stream
   requires the badge issuer, owner, `badge_scope=v1`, and a device ID. It is not
   auto-subscribed; the badge requests it explicitly. These restrictions prevent
   a badge from subscribing to full browser history.

```sh
npx --yes powersync@0.10.2 deploy sync-config --instance-id=6ad76c8f2f27853eb0b0a128 --dry-run
npx --yes powersync@0.10.2 deploy sync-config --instance-id=6ad76c8f2f27853eb0b0a128
npx --yes powersync@0.10.2 status --instance-id=6ad76c8f2f27853eb0b0a128 --output=json
```

   Wait for these exact guarded streams to be active and replication healthy.
   Confirm an existing signed-in browser still syncs its own data. A schema or
   missing-table warning must now be resolved; do not skip validations.

5. **Enable the badge key last — completed.** After the guarded streams are active, apply
   only the reviewed `jwks_uri` addition above to the existing local service
   file. Compare the complete candidate with the saved current remote config;
   there must be no incidental source, secret, region, or auth changes.

```sh
npx --yes powersync@0.10.2 deploy service-config --instance-id=6ad76c8f2f27853eb0b0a128 --dry-run
npx --yes powersync@0.10.2 deploy service-config --instance-id=6ad76c8f2f27853eb0b0a128
npx --yes powersync@0.10.2 status --instance-id=6ad76c8f2f27853eb0b0a128 --output=json
```

   Never use the combined `deploy` command for this change: stream protection
   must be active before badge JWTs become accepted.

6. **Pair-once wellness flow — completed on the installed alpha.4 app.** Physical
   ABC entry, exact matching-ID approval, saved credential reuse, actual PowerSync
   checkpoint completion, badge-to-web hydration and independent web-to-badge
   movement all passed. Two owner-confirmed C presses yielded two events/receipts;
   Home/reopen produced no duplicate uploads and asked for no code. The browser
   remains signed in and All connected. This run used the local web app on port
   5174; it does not verify the current Vercel deployment.

   **Additional resilience/product gates remain separate.** Host tests cover
   captured-request replay, but this run did not force a lost live upload reply,
   radio loss, timed token expiry, or live device revocation. Measure those before
   making stronger retry/revocation guarantees. Account-timer mutation parity,
   public ingress limits, and broader capacity/power-loss qualification remain
   outside this completed pair-once wellness verification.

## Historical pairing evidence and remaining limits

At the alpha.4 pairing baseline, local backend type checks and lint passed; **30 Deno tests** passed (12 gateway and
18 existing pet-AI tests). The saved PostgreSQL/WASM runner passes schema,
owner/session/privilege, pairing/replay, revocation, atomic receipt, projection,
Unicode-bound and rate-counter assertions. **17 actual sync-policy checks** pass
for the checked-in streams. Before deployment, CLI validation passed with the
expected missing-`badge_projection` warning. The table now exists. Subsequent
live validation caught its missing replication-reader grant; the narrowly scoped
followup migration was applied before stream deployment continued. Schema and
gateway deployment are confirmed, and the public JWKS/auth rejection checks above
passed. Guarded-stream activation and custom-signer acceptance are now confirmed
with no replication errors and zero final lag. The security advisor reported only
the existing `auth_leaked_password_protection` warning, with no schema warnings.
The [sanitized activation evidence](../badge/evidence/cloud-activation-alpha3.json)
records the cloud checks. The [alpha.4 evidence](../badge/evidence/sync-fix-alpha4.json)
records the installed-app roundtrip, Home/reopen, persisted checkpoint, empty
queues, preservation hashes and final backup. The two protocol fixes passed
37 focused parser, actual-core, packaging and checked-update tests. No full-capacity
native stress fixture was rerun.

The alpha.4 baseline implemented hydration/movement upload and current pet/timer/
daily-summary download. Alpha.5 adds shared timer CAS transitions and badge-generated
AI intentions, as recorded above. Credential rotation and abandoned-claim cleanup
remain outside this rollout.
Device credentials last 180 days; issued PowerSync JWTs last 300 seconds. Further
storage/power-loss qualification, real concurrent database transactions and live
revocation timing remain separate acceptance evidence. Owner Auth integration
and physical pairing are verified.

Durable global, owner, code, pending-secret and credential limits are implemented.
A trusted ingress IP limiter remains a prerequisite for public rollout; no
forwarding header is trusted. This activation is an owner-approved development
exercise, not approval to expose a general public pairing service.

For rollback, remove badge JWKS trust first and keep the guarded streams. Leave
canonical data, receipts and private registration records intact. Never restore
broad browser streams while badge credentials can still be accepted. Restoring
service configuration is itself a scoped cloud action; report the failure and
obtain any authorization not already covered by the activation approval.

Full endpoint details are in the [pairing gateway contract](../supabase/functions/badge-gateway/README.md)
and [shared command contract](../supabase/functions/badge-gateway/COMMANDS.md).
