# Badge pairing: cloud activation review

Updated October 20, 2026. The owner approved activation on the exact development
targets below. This document records completed work and the remaining ordered
gates; do not rerun completed mutations merely because their commands are shown.

## Activation status

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

The instance is labeled **Production**, but the owner recorded it as a development
target in the repository. The owner has now approved the specific activation
steps recorded here. Verify [the link](../powersync/cli.yaml) still matches before
any remaining mutation. No Vercel deployment or Git push is included.

Activate only:

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

## Approved activation order and remaining gates

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

## Evidence and remaining limits

Local backend type checks and lint pass; **30 Deno tests** pass (12 gateway and
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

The initial shared behavior is hydration/movement upload and current pet/timer/
daily-summary download. It does not implement shared timer CAS transitions,
badge-generated AI intentions, credential rotation, or abandoned-claim cleanup.
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

Full endpoint details are in the [gateway contract](../supabase/functions/badge-gateway/README.md).
