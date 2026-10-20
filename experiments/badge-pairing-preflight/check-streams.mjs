#!/usr/bin/env node
// Read-only candidate-policy proof against the locally built PowerSync service.
// Does not read credentials, connect to cloud services, or modify either checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as sqlite from 'node:sqlite';

const root = process.env.POWERSYNC_SERVICE_SOURCE ?? '/Users/kobie/projects/powersync/powersync-service';
const api = await import(pathToFileURL(path.join(root, 'packages/sync-rules/dist/index.js')));
const { SqlSyncRules, DEFAULT_HYDRATION_STATE, DEFAULT_TAG, nodeSqlite, RequestParameters, RequestJwtPayload } = api;
const browserIssuer = 'https://bfccerfayrfolisawokp.supabase.co/auth/v1';
// Proposed issuer identifier, NOT an existing deployed endpoint contract.
const badgeIssuer = 'https://bfccerfayrfolisawokp.supabase.co/functions/v1/badge-gateway';
const ownerA = 'aaaaaaaa-0000-4000-8000-000000000001';
const ownerB = 'bbbbbbbb-0000-4000-8000-000000000002';
const device = 'dddddddd-0000-4000-8000-000000000004';
const fullTables = ['sessions', 'wellness_events', 'daily_activity_summary', 'pet_sessions', 'pet_events'];
const projectionTables = ['badge_current_pet', 'badge_current_session', 'badge_current_summary', 'badge_recent_activity'];
const streamNames = [...fullTables.map(t => `web_${t}`), ...projectionTables];
const browserGuard = `owner_id = auth.user_id() AND auth.parameter('iss') = '${browserIssuer}' AND auth.parameter('badge_scope') IS NULL`;
const badgeGuard = `owner_id = auth.user_id() AND auth.parameter('iss') = '${badgeIssuer}' AND auth.parameter('badge_scope') = 'v1' AND auth.parameter('device_id') IS NOT NULL`;
const yaml = 'config:\n  edition: 3\nstreams:\n' + [
  ...fullTables.map(table => `  web_${table}:\n    auto_subscribe: true\n    query: SELECT * FROM ${table} WHERE ${browserGuard}\n`),
  ...projectionTables.map(table => `  ${table}:\n    auto_subscribe: true\n    query: SELECT * FROM ${table} WHERE ${badgeGuard}${table === 'badge_recent_activity' ? ' AND slot >= 0 AND slot < 8' : ''}\n`),
].join('');

const compiled = SqlSyncRules.fromYaml(yaml, { defaultSchema: 'public', throwOnError: false });
assert.deepEqual(compiled.errors, [], 'candidate config compiles without warnings or errors');
const config = compiled.config.hydrate({ hydrationState: DEFAULT_HYDRATION_STATE, sqlite: nodeSqlite(sqlite) });
const rows = [];
for (const owner of [ownerA, ownerB]) {
  for (const table of [...fullTables, ...projectionTables.filter(t => t !== 'badge_recent_activity')]) {
    rows.push({ table, record: { id: `${owner}:${table}`, owner_id: owner, value: 'fixture' } });
  }
  // Include negative, too-large, and null slots to test the row filter itself.
  for (const slot of [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 99, null]) {
    rows.push({ table: 'badge_recent_activity', record: { id: `${owner}:slot:${slot}`, owner_id: owner, slot } });
  }
}

function visible(payload, { connection = {}, subscription = null, explicit = false, defaults = true } = {}) {
  const streams = explicit ? Object.fromEntries(streamNames.map(name => [name, [{ opaque_id: 0, priorityOverride: null, parameters: subscription }]])) : {};
  const { querier, errors } = config.getBucketParameterQuerier({
    globalParameters: new RequestParameters(new RequestJwtPayload(payload), connection),
    hasDefaultStreams: defaults,
    streams,
  });
  assert.deepEqual(errors, [], 'request parameter evaluation');
  assert.equal(querier.hasDynamicBuckets, false, 'candidate uses static owner buckets only');
  const allowed = new Set(querier.staticBuckets.map(b => b.bucket));
  const selected = [];
  for (const { table, record } of rows) {
    const evaluated = config.evaluateRow({ sourceTable: { connectionTag: DEFAULT_TAG, schema: 'public', name: table }, record });
    for (const result of evaluated) {
      assert.ok(!('error' in result), `row evaluation error: ${String(result.error)}`);
      if (allowed.has(result.bucket)) selected.push({ table: result.table, ...result.data });
    }
  }
  return selected;
}

const browserA = { sub: ownerA, iss: browserIssuer };
const badgeA = { sub: ownerA, iss: badgeIssuer, badge_scope: 'v1', device_id: device };
const attempts = { sub: ownerB, owner_id: ownerB, iss: browserIssuer, badge_scope: null, device_id: device, slot: 99, limit: 100000, include_defaults: true };
let passed = 0;
function check(name, body) { body(); passed++; console.log(`PASS ${name}`); }
function assertNone(payload, options) { assert.deepEqual(visible(payload, options), []); }

check('candidate edition-3 config compiles all nine streams', () => assert.equal(streamNames.length, 9));
check('browser issuer receives all five own full-history table fixtures', () => {
  const got = visible(browserA);
  assert.deepEqual(got.map(r => r.table).sort(), [...fullTables].sort());
  assert.ok(got.every(r => r.owner_id === ownerA));
});
check('badge receives only own projections and exactly eight valid activity slots', () => {
  const got = visible(badgeA);
  assert.equal(got.length, 11);
  assert.ok(got.every(r => projectionTables.includes(r.table) && r.owner_id === ownerA));
  assert.deepEqual(got.filter(r => r.table === 'badge_recent_activity').map(r => r.slot), [0,1,2,3,4,5,6,7]);
});
check('owner B receives no owner A rows', () => {
  const got = visible({ ...badgeA, sub: ownerB });
  assert.equal(got.length, 11);
  assert.ok(got.every(r => r.owner_id === ownerB));
});
check('unknown owner receives no rows', () => assertNone({ ...badgeA, sub: 'unknown' }));
check('badge issuer without scope cannot fall back to browser streams', () => assertNone({ sub: ownerA, iss: badgeIssuer, device_id: device }));
check('badge issuer with null scope cannot fall back to browser streams', () => assertNone({ ...badgeA, badge_scope: null }));
check('unsupported badge scope receives no streams', () => assertNone({ ...badgeA, badge_scope: 'v2' }));
check('badge without trusted device identity receives no streams', () => assertNone({ sub: ownerA, iss: badgeIssuer, badge_scope: 'v1' }));
check('wrong issuer with otherwise valid badge claims receives no streams', () => assertNone({ ...badgeA, iss: 'https://attacker.invalid' }));
check('missing issuer receives no streams', () => assertNone({ sub: ownerA, badge_scope: 'v1', device_id: device }));
check('development token with no configured issuer receives no streams', () => assertNone({ sub: ownerA, aud: 'development' }));
check('lookalike browser issuer cannot receive full history', () => assertNone({ sub: ownerA, iss: `${browserIssuer}/other` }));
check('Supabase browser issuer cannot opt into badge streams by setting badge scope', () => assertNone({ ...browserA, badge_scope: 'v1', device_id: device }));
check('forged connection parameters cannot expand badge scope or change owner', () => assert.deepEqual(visible(badgeA, { connection: attempts }), visible(badgeA)));
check('forged subscription parameters and explicit full-stream names cannot expand badge access', () => assert.deepEqual(visible(badgeA, { subscription: attempts, explicit: true }), visible(badgeA)));
check('both forged parameter channels cannot substitute for missing trusted claims', () => assertNone({ sub: ownerA }, { connection: attempts, subscription: { ...badgeA }, explicit: true }));
check('browser connection and subscription parameters cannot access owner B or badge projections', () => assert.deepEqual(visible(browserA, { connection: attempts, subscription: { ...badgeA, sub: ownerB }, explicit: true }), visible(browserA)));
check('include_defaults=false plus explicit requests preserves badge authorization', () => assert.deepEqual(visible(badgeA, { subscription: attempts, explicit: true, defaults: false }), visible(badgeA)));
check('include_defaults=false and no explicit requests receives nothing', () => assertNone(badgeA, { defaults: false }));
check('new full-history data cannot increase badge rows', () => {
  const before = visible(badgeA);
  for (let n = 0; n < 1000; n++) rows.push({ table: 'wellness_events', record: { id: `history-${n}`, owner_id: ownerA, value: 'history' } });
  assert.deepEqual(visible(badgeA), before);
  assert.equal(visible(browserA).length, 1005);
});
for (const suffix of ['LIMIT 1', 'ORDER BY id DESC']) {
  check(`${suffix} rejected by compiler`, () => {
    const probe = SqlSyncRules.fromYaml(`config:\n  edition: 3\nstreams:\n  probe:\n    query: SELECT * FROM sessions WHERE owner_id = auth.user_id() ${suffix}\n`, { defaultSchema: 'public', throwOnError: false });
    assert.ok(probe.errors.some(e => e.message.includes(`${suffix.startsWith('LIMIT') ? 'LIMIT' : 'ORDER BY'} is not supported`)));
  });
}

const metadata = {
  command: `node experiments/badge-pairing-preflight/check-streams.mjs`,
  node: process.version,
  source: root,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'packages/sync-rules/package.json'), 'utf8')).version,
  passed,
  scope: 'Local compiled query and bucket evaluator proof only; no JWT signature checks, deployed-service compatibility, database cardinality constraints, or device storage qualification.',
};
console.log(JSON.stringify(metadata, null, 2));
