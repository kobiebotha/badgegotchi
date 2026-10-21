// Isolated PostgreSQL/WASM contract tests; no cloud or hardware access.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
if (!process.argv[2]) throw new Error("Pass pinned PGlite dist/index.js path");
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
try {
  await db.exec(
    `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid,not_after timestamptz); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;`,
  );
  for (
    const name of [
      "20261020162510_badgegotchi_cloud_sync.sql",
      "20261020170338_pet_events_web_source.sql",
      "20261020204932_badge_pairing_gateway.sql",
      "20261020224246_shared_account_commands.sql",
    ]
  ) {
    await db.exec(
      fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8"),
    );
  }
  const compactMigration = fs.readFileSync(
    path.join(root, "supabase/migrations/20261021004457_compact_badge_projection.sql"),
    "utf8",
  );
  // Apply the real migration to pre-existing projections and source-only
  // owners, then discard fixtures before the command/worker contract suite.
  await db.exec("BEGIN");
  await db.exec(fs.readFileSync(path.join(root, "supabase/tests/compact_projection_before.sql"), "utf8"));
  await db.exec(compactMigration);
  const size = await db.query(`
    SELECT (SELECT sum(octet_length(payload::text)) FROM compact_projection_before) AS before_bytes,
           (SELECT sum(octet_length(payload)) FROM public.badge_projection
            WHERE owner_id = 'aaaaaaaa-0000-4000-8000-000000000020') AS after_bytes
  `);
  if (Number(size.rows[0].after_bytes) >= Number(size.rows[0].before_bytes))
    throw new Error("Compact projection did not reduce synced payload bytes");
  await db.exec(fs.readFileSync(path.join(root, "supabase/tests/compact_projection.sql"), "utf8"));
  await db.exec("ROLLBACK");
  await db.exec(compactMigration);
  console.log("Passed: compact projection backfill, consumed fields, audit-only no-op writes, counters/timer/status, privileges");
  console.log(`Projection fixture payload bytes: ${size.rows[0].before_bytes} -> ${size.rows[0].after_bytes}`);
  await db.exec(
    fs.readFileSync(
      path.join(root, "supabase/tests/account_commands.sql"),
      "utf8",
    ),
  );
  // Exercise the optional wake trigger against a deliberately failed pg_net shim.
  // Only the transport is mocked: actual trigger + command transaction run in PG.
  await db.exec(
    `CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets(name text,decrypted_secret text); INSERT INTO vault.decrypted_secrets VALUES('badgegotchi_pet_worker_url','https://example.test/worker'),('badgegotchi_pet_worker_secret',repeat('w',64)); CREATE SCHEMA net; CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated transport failure'; END $$;`,
  );
  const schedule = fs.readFileSync(
    path.join(root, "supabase/operations/schedule-pet-worker.sql"),
    "utf8",
  );
  await db.exec(
    schedule.slice(
      schedule.indexOf("CREATE OR REPLACE FUNCTION private.pet_worker_wake()"),
      schedule.lastIndexOf("COMMIT;"),
    ),
  );
  await db.exec(
    fs.readFileSync(
      path.join(root, "supabase/tests/account_commands.sql"),
      "utf8",
    ),
  );
  await db.exec(
    fs.readFileSync(
      path.join(root, "supabase/operations/activate-shared-commands.sql"),
      "utf8",
    ),
  );
  const rights = await db.query(
    `SELECT has_table_privilege('authenticated','public.sessions','INSERT') AS session_write,has_table_privilege('authenticated','public.wellness_events','INSERT') AS wellness_write,has_table_privilege('authenticated','public.sessions','SELECT') AS session_read`,
  );
  if (
    rights.rows[0].session_write || rights.rows[0].wellness_write ||
    !rights.rows[0].session_read
  ) throw new Error("Activation privileges incorrect");
  // Service-role invoker functions must work without postgres privileges.
  await db.exec(
    `INSERT INTO auth.users VALUES('aaaaaaaa-0000-4000-8000-000000000010'); INSERT INTO auth.sessions(id,user_id) VALUES('aaaaaaaa-0000-4000-8000-000000000011','aaaaaaaa-0000-4000-8000-000000000010'); SET ROLE service_role;`,
  );
  const fresh = await db.query(
    `SELECT public.account_gateway('command','aaaaaaaa-0000-4000-8000-000000000010',jsonb_build_object('auth_session_id','aaaaaaaa-0000-4000-8000-000000000011','command',jsonb_build_object('id',gen_random_uuid(),'type','hydration','occurred_at',now()))) AS receipt`,
  );
  if (fresh.rows[0].receipt.state !== "accepted") {
    throw new Error("Service role command failed");
  }
  console.log(
    "Passed: failed wake preserves acceptance, rollout activation privileges, service-role execution",
  );
  console.log(
    "Passed: atomic receipts, timer CAS/offline chain/completion, canonical counts, worker recovery, RLS",
  );
} catch (error) {
  console.error(error.message, error.where ?? "");
  process.exitCode = 1;
} finally {
  await db.close();
}
