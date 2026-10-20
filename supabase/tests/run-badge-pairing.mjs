// Isolated PostgreSQL/WASM runner. Install the pinned dependency in /tmp and
// pass its entrypoint; no application dependency or cloud connection is needed.
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
if (!process.argv[2]) throw new Error('Pass the absolute path to @electric-sql/pglite/dist/index.js');
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  // Supabase-owned objects are minimal fixtures; these tests do not simulate
  // GoTrue or replace a real Supabase deployment test.
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users,not_after timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
  `);
  for (const relative of [
    'supabase/migrations/20261020162510_badgegotchi_cloud_sync.sql',
    'supabase/migrations/20261020204932_badge_pairing_gateway.sql',
    'supabase/tests/badge_pairing.sql',
  ]) {
    await db.exec(fs.readFileSync(path.join(root, relative), 'utf8'));
    console.log(`Passed: ${relative}`);
  }
  await db.exec(`
    INSERT INTO auth.users VALUES('aaaaaaaa-0000-4000-8000-000000000001');
    INSERT INTO auth.sessions(id,user_id) VALUES('aaaaaaaa-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000001');
    SET ROLE service_role;
  `);
  const result = await db.query(`SELECT public.badge_gateway('create_pairing',
    'aaaaaaaa-0000-4000-8000-000000000001',jsonb_build_object(
    'auth_session_id','aaaaaaaa-0000-4000-8000-000000000002','code_hash',repeat('a',64))) as result`);
  if (result.rows[0].result.state !== 'pending') throw new Error('service_role could not create a pairing');
  await db.exec('RESET ROLE; SET ROLE authenticated;');
  let refused = false;
  try { await db.query("SELECT public.badge_gateway('list_devices',null,'{}')"); }
  catch (error) { refused = error.code === '42501'; }
  if (!refused) throw new Error('authenticated role bypassed the gateway');
  console.log('Passed: service_role execution and authenticated RPC denial');
} catch (error) {
  console.error(error.message, error.where ?? '');
  process.exitCode = 1;
} finally { await db.close(); }
