# Badge gateway

Local implementation for an account owner to display a 12-button ABC code,
confirm the exact badge claim, and give that badge its own revocable credential.
The badge then gets a short PowerSync download token and uploads hydration or
movement events through this gateway. No cloud change is made by these files.

## Wire contract

POST `/functions/v1/badge-gateway`, JSON with `action`; maximum body 8,192 bytes.
Owner actions require an existing Supabase user Bearer token. The function calls
Auth `/user`, then the transaction checks that token's `session_id` still belongs
to the owner in `auth.sessions`. Owner IDs in request bodies are rejected.

| Action | Fields | Result |
| --- | --- | --- |
| `create_pairing` | none | `session_id, code, expires_at, state` |
| `status_pairing` | `session_id` | `session_id, state, expires_at, claims` |
| `cancel_pairing` | `session_id` | `session_id, state` (may already be approved) |
| `approve_claim` | `session_id, claim_id, name?` | `state, device_id, claim_id` |
| `list_devices` | none | `devices: [{device_id,name,state,paired_at,last_seen_at,revoked_at}]` |
| `revoke_device` | `device_id` | `state, device_id` |
| `claim` | `code, pending_secret, credential` | `claim_id, verification_id, state, expires_at` |
| `poll` | `pending_secret` | `claim_id, verification_id, state, device_id?, owner_id?` |
| `ack` | `credential` | `state, device_id, owner_id` |
| `token` | `credential` | `token, endpoint, expires_at, device_id, owner_id` |
| `upload` | `credential, request_id, events` | `state: accepted, request_id, accepted` |

`pending_secret` and `credential` are independent, device-generated 32-byte
secrets encoded as 64 lowercase hex characters, persisted before claim. The
code lasts five minutes and is returned only during creation. Three candidate
claims and five active devices per owner are allowed. `verification_id` is an
immutable uppercase `XXXX-XXXX` hex identifier bound to both candidate secrets.
Approval requires the exact claim ID. Metadata polling never delivers a secret.
An approved claim can recover its metadata for 24 hours, including an original
claim response lost immediately before approval. Credentials expire after 180
days; this first version requires pairing again afterward and has no credential
rotation protocol. Revoke immediately rejects uploads and token requests,
including retries of previously accepted receipts.

Events are 1–8 unique UUID entries with `id, type, occurred_at, day_key`.
`type` is `hydration` or `movement`. Timestamp is UTC ISO8601 and the day is its
UTC date; events older than 30 days or more than five minutes ahead are rejected.
One transaction validates all entries, inserts canonical wellness events, updates
projections, and stores the receipt. The request UUID and exact canonical payload
hash provide lost-response recovery. Reusing an ID with another payload conflicts.
Domain conflicts preserve the local queue; HTTP acceptance is not a PowerSync
checkpoint or server echo.

Errors are `{error: code}`. `unauthorized` is 401; pairing unavailable, conflicting
request/event IDs and device limit are 409; invalid fields/events are 400; rate
limit is 429; provider/configuration failure is 503. Retain pending work on
ambiguous failures. Poll states include pending, approved, delivered, rejected,
expired, cancelled and revoked.

## Bounded downloads

`public.badge_projection` has at most three rows per owner, with unique fixed
`kind` slots `pet`, `timer`, `summary`, IDs `${owner_id}:${kind}`, and maximum
1,536 UTF-8 bytes per JSON-text payload. Triggers maintain it when web or badge
canonical writes happen, and token renewal refreshes the current UTC day.

- `pet`: `id, animal_id, name, speech, updated_at`; omitted without a pet.
- `timer`: `id, type, state, planned_duration_seconds, started_at,
  last_resumed_at, paused_at, remaining_seconds_at_pause`; omitted without an
  active/paused timer. It displays the latest timer if legacy concurrent timers
  already exist; it does not implement timer conflict resolution.
- `summary`: `day_key, completed_focus_count, stopped_focus_count,
  completed_break_count, stopped_break_count, hydration_count, movement_count,
  last_hydration_at`. Counts come from canonical history, not client summaries.

Control characters are removed and projected text is truncated before encoding.
The source history is preserved. No credentials, private tables or receipts are
published. The migration refuses an existing `FOR ALL TABLES` PowerSync
publication. The badge stream must additionally enforce issuer, owner, scope and
device claims; browser full-history streams must exclude badge JWTs.

## Deployment review

Apply the new migration and deploy this function only after reviewing the cloud
auth and stream changes together. Keep existing `pet-ai` JWT verification.
This gateway intentionally has `verify_jwt=false`: public bootstrap/JWKS and
opaque device credentials need custom checks, and all owner routes validate Auth.

Required server-only values (none belong in Vite or badge source):

- `BADGE_HMAC_KEY`: 64 lowercase hex characters from 32 cryptographic random bytes.
  Keep stable; changing it invalidates all existing code/credential lookups.
- `BADGE_SIGNING_JWK`: private EC P-256 JSON JWK containing `d`.
- `BADGE_SIGNING_KID`: identifier for that key.
- `BADGE_POWERSYNC_URL`: HTTPS sync endpoint.
- `BADGE_POWERSYNC_AUDIENCE`: exact audience accepted by the target service.
- Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

GET `/functions/v1/badge-gateway/jwks` returns only public `kty,crv,x,y,kid,alg,use`.
Tokens use ES256, owner UUID `sub`, 300-second `exp`, `iat`, exact instance
`aud`, device UUID `device_id`, and `badge_scope: v1`. Issuer is exactly
`${SUPABASE_URL}/functions/v1/badge-gateway`. Expected development issuer:
`https://bfccerfayrfolisawokp.supabase.co/functions/v1/badge-gateway`.

PowerSync's reviewed service-auth addition is the JWKS URL above while retaining
`client_auth.supabase: true`. Live audience acceptance, JWKS caching and existing
connection behavior after token expiration/revocation remain deployment tests.
Five minutes is the issued token lifetime, not a measured maximum revocation lag.

Durable fixed-window limits are: all POST requests 240/minute, owner 120/minute,
code creation 6/hour/owner, all claims 20/minute, each code 6/minute, each pending
secret 30/minute and each credential 60/minute. Failed attempts count. Rate rows
older than two hours are removed. No client-controlled forwarding/IP header is
trusted. A verified ingress IP limiter is still required before public rollout;
the aggregate limiter bounds guessing but lets an anonymous attacker consume the
shared budget. `Retry-After: 60` is a minimum retry hint, not a promise that an
hourly owner limit has reset.

This increment does not add shared timer CAS transitions, badge pet AI intentions,
credential rotation, abandoned-claim retention jobs, or a live tested deployment.
Existing web pet AI and timer writes keep their prior behavior.

## Verification

`deno task --config supabase/deno.json check`, `test`, and `lint` cover both Edge
Functions. Twelve gateway tests include actual ES256 signing/verification,
public-only JWKS, owner/session binding, hash-only database inputs, request byte
limits, duplicate/conflicting uploads, revocation and generic provider errors.

`supabase/tests/badge_pairing.sql` runs real PostgreSQL transaction assertions
and rolls all fixtures back. With Docker unavailable, it was run against pinned
PGlite PostgreSQL/WASM, including service-role execution and authenticated-role
denial, without touching cloud data:

```sh
npm install --prefix /tmp/badge-pairing-pgtest --no-audit --no-fund @electric-sql/pglite@0.3.14
node supabase/tests/run-badge-pairing.mjs /tmp/badge-pairing-pgtest/node_modules/@electric-sql/pglite/dist/index.js
```

This validates SQL execution, lifecycle replay, owner isolation, privilege grants,
atomic rejection/receipts, canonical write projections, Unicode bounds and rate
counters. PGlite uses one connection; true simultaneous transaction races and
actual Supabase Auth/Edge integration are separate deployment checks.
