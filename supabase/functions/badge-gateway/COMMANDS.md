# Shared account command contract

Both clients POST to `badge-gateway` with `action: "command"` and one `command` object. A badge supplies its opaque `credential`; a browser supplies its Supabase bearer instead. Owner and source are derived by the server. Caller ownership/source fields are rejected.

Every command contains a stable UUID `id`, `type`, and UTC `occurred_at` (`Z`, seconds or milliseconds). The server normalizes timestamps before storing the immutable receipt. Accepted and rejected receipts survive retries; changing the payload under an existing ID rejects it. Exact retries from another device belonging to the same account return the same receipt. Revoked credentials cannot retrieve receipts.

| Type | Additional fields |
| --- | --- |
| `hydration`, `movement` | none |
| `pet` | `pet_session_id` |
| `timer_start` | `new_session_id`, `session_type` (`focus`/`break`), `expected_revision` |
| `timer_pause`, `timer_resume`, `timer_complete`, `timer_stop` | `session_id`, `expected_revision` |
| `reset_day` | `day_key` matching `occurred_at`, `expected_revision` |

Revisions are decimal strings. Every accepted timer/reset command advances the account revision once; a duplicate completion for an already completed session acknowledges without advancing or generating another reaction. A stale revision rejects atomically. Start requires no live timer. Completion requires an elapsed active timer and creates the opposite phase paused at full duration. Stop creates the same phase paused. The successor session ID equals the completion/stop command ID, so offline clients can queue its resume. Focus is 2400 seconds; break is 600 seconds.

Recorded occurrence time determines elapsed duration, including offline chains. First acceptance allows at most 30 days of age and five minutes of future clock skew; future timestamps are clamped to server time. Timer transitions before their previous transition reject. Exact receipt retries are checked before age validation.

Receipts use HTTP 200 for terminal domain outcomes:

```json
{"state":"accepted","command_id":"UUID","revision":"1","timer":{"revision":"1","last_command_id":"UUID","id":"UUID","type":"focus","state":"active","planned_duration_seconds":2400,"started_at":"ISO","last_resumed_at":"ISO","paused_at":null,"remaining_seconds_at_pause":2400}}
```

Rejections use `state: "rejected"` plus `reason` and the current timer/revision. Clients acknowledge terminal rejects, show the conflict, and reconcile queued dependent commands. Transport/auth failures remain HTTP errors. A receipt confirms a backend commit; clients keep accepted work pending until the corresponding PowerSync checkpoint or row/revision arrives. Wellness and pet event IDs equal the command ID.

`action: "refresh"` uses the same authentication and returns current `{timer, summary, pet?}` projections. Use it on browser open and UTC rollover. Timer always exists, including idle (`id:null`, revision `"0"` initially). Summary counts confirmed UTC-day activity and distinguishes ended, completed, and stopped focus/break phases; `pet_count` counts accepted pet interactions independent of inference success. Projection writes are skipped when unchanged.

## Durable pet inference

An accepted action inserts its pet intent in the same database transaction. `pet-worker` takes an independently authenticated service secret, leases one due event, and reuses the established provider/finish path. A 90-second lease recovers crashes; persisted exponential backoff and eight attempts bound retries. Stale pet sessions terminate without replacing a newer pet. Prompt pg_net wakeups dispatch after commit; failed wakeups do not roll back acceptance. The independent one-minute cron scan recovers missed wakeups and expired leases.

## Rollout order

1. Apply the additive migration. Existing direct-write web clients remain usable; their timer mutations advance the shared revision.
2. Deploy updated `badge-gateway`, `pet-ai`, and dedicated `pet-worker`. Set a fresh `PET_WORKER_SECRET` only on the backend.
3. Create Vault secrets `badgegotchi_pet_worker_url` and `badgegotchi_pet_worker_secret` out of band. Run `supabase/operations/schedule-pet-worker.sql` to enable pg_cron/pg_net, prompt wakeups, and durable retries. Verify one accepted intent reaches terminal status.
4. Publish the updated web/badge clients and guarded browser projection stream.
5. Separately review and run `supabase/operations/activate-shared-commands.sql`. It refuses ambiguous live timers, revokes old direct session/wellness mutations, and adds the one-live-timer constraint. Older web bundles cannot write after this activation.

No activation or deployment is implied by the local migration. The optional scheduling and activation scripts are outside automatic migrations intentionally.

## Local verification

Run `deno test supabase/functions/badge-gateway/handler_test.ts supabase/functions/pet-ai/handler_test.ts` and `node supabase/tests/run-account-commands.mjs /absolute/path/to/@electric-sql/pglite/dist/index.js` (pinned PGlite 0.5.10). The SQL tests exercise the real functions, role grants, revision/receipt semantics and failed-wakeup transactions; they do not replace live Auth, concurrent PostgreSQL, pg_net or PowerSync deployment checks.
