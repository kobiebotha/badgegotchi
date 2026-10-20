# Badge pairing: cloud activation review

Prepared October 20, 2026. This is the concrete activation plan for the local
implementation. No command below has been run to deploy this change, and
`powersync/service.yaml` has not been edited. Obtain the owner's approval for
these named targets and changes after device qualification is complete.

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
target in the repository. That record identifies the environment; it does not
approve this service-auth change. Verify [the link](../powersync/cli.yaml) still
matches before applying anything. No Vercel deployment or Git push is included.

Activate only:

- [The pairing migration](../supabase/migrations/20261020204932_badge_pairing_gateway.sql): private pairing/device/credential/receipt tables, atomic RPCs, and the bounded public projection. Existing source history is preserved.
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
no additional audience setting is needed for this standard Cloud URL. Actual
acceptance by the deployed service remains an activation check.

## Activation order after approval

Run from `/Users/kobie/projects/powersync/skunkworks/badgegotchi`. The installed
Supabase CLI help and PowerSync CLI `0.10.2` help were inspected for these flags.
Keep credentials in their existing CLI authentication stores or private env
files, never in command arguments or logged output. Stop on a failed check.

1. **Check the targets and pending migration.** Save the current remote service
   and stream configuration privately for comparison/rollback, using `fetch
   config`, which does not overwrite local files. Do not use `pull instance`
   against this edited checkout.

```sh
BADGE_CONFIG_BEFORE=$(mktemp /private/tmp/badge-pairing-config.XXXXXX)
npx --yes powersync@0.10.2 fetch config --instance-id=6ad76c8f2f27853eb0b0a128 --output=json > "$BADGE_CONFIG_BEFORE"
npx --yes powersync@0.10.2 status --instance-id=6ad76c8f2f27853eb0b0a128 --output=json
supabase db push --project-ref bfccerfayrfolisawokp --skip-vault --dry-run
```

   The migration dry run must list only the intended new pairing migration. If
   other migrations or target drift appear, resolve the difference before writing.

2. **Apply the schema, then verify publication and privileges.** The migration
   rejects an existing `FOR ALL TABLES` PowerSync publication. Only
   `public.badge_projection` is added; no private table may be replicated.

```sh
supabase db push --project-ref bfccerfayrfolisawokp --skip-vault
```

   Check the created tables/RPC grants, projection maximum of three rows per
   owner and 1,536 bytes per payload, source row preservation, and publication
   membership using read-only SQL. Do not run the fixture-writing SQL tests on
   the shared cloud database.

3. **Provision server-only configuration and deploy only the new gateway.**
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

4. **Deploy the stream guards before trusting the badge key.** All five browser
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

5. **Enable the badge key last.** After the guarded streams are active, apply
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

6. **Prove the complete flow.** Use the local web app and qualified badge:
   display the ABC code, enter it with A/B/C, compare the immutable verification
   identifier, approve that exact claim, and reach a real PowerSync checkpoint.
   Confirm at most three projection rows and no browser-history rows. Record
   hydration on the badge, observe the canonical Supabase event and web update,
   and verify the resulting projection echo. Retry a captured upload and confirm
   one event/receipt; restart and reconnect with the saved credential. Revoke a
   test device and confirm uploads/token renewal fail. Measure the behavior of
   an already-open sync connection and the existing JWT after revocation; do not
   assume issued-token lifetime is the full revocation delay. Recheck browser auth.

## Evidence and remaining limits

Local backend type checks and lint pass; **30 Deno tests** pass (12 gateway and
18 existing pet-AI tests). The saved PostgreSQL/WASM runner passes schema,
owner/session/privilege, pairing/replay, revocation, atomic receipt, projection,
Unicode-bound and rate-counter assertions. **17 actual sync-policy checks** pass
for the checked-in streams. CLI validation also passed, with the expected warning
that `badge_projection` does not yet exist in the undeployed cloud schema. These
results do not establish a live badge checkpoint or a deployed migration.

The initial shared behavior is hydration/movement upload and current pet/timer/
daily-summary download. It does not implement shared timer CAS transitions,
badge-generated AI intentions, credential rotation, or abandoned-claim cleanup.
Device credentials last 180 days; issued PowerSync JWTs last 300 seconds. Device
storage/power-loss qualification, real concurrent database transactions, live
Auth/JWKS integration and revocation timing remain separate acceptance evidence.

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
