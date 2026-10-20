#!/usr/bin/env node
// Compiles the actual checked-in policy, then evaluates owner and scope boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as sqlite from 'node:sqlite';
const source = process.env.POWERSYNC_SERVICE_SOURCE ?? '/Users/kobie/projects/powersync/powersync-service';
const api = await import(pathToFileURL(path.join(source, 'packages/sync-rules/dist/index.js')));
const {SqlSyncRules, DEFAULT_HYDRATION_STATE, DEFAULT_TAG, nodeSqlite, RequestParameters, RequestJwtPayload} = api;
const yaml = fs.readFileSync(new URL('../sync-config.yaml', import.meta.url), 'utf8');
const parsed = SqlSyncRules.fromYaml(yaml, {defaultSchema: 'public', throwOnError: false});
assert.deepEqual(parsed.errors, []);
const config = parsed.config.hydrate({hydrationState: DEFAULT_HYDRATION_STATE, sqlite: nodeSqlite(sqlite)});
const tables = ['sessions','wellness_events','daily_activity_summary','pet_sessions','pet_events'];
const names = [...tables, 'badge_projection'];
const ownerA='aaaaaaaa-0000-4000-8000-000000000001', ownerB='bbbbbbbb-0000-4000-8000-000000000002';
const browser={sub:ownerA,iss:'https://bfccerfayrfolisawokp.supabase.co/auth/v1'};
const badge={sub:ownerA,iss:'https://bfccerfayrfolisawokp.supabase.co/functions/v1/badge-gateway',badge_scope:'v1',device_id:'dddddddd-0000-4000-8000-000000000004'};
const rows=[];
for(const owner of [ownerA,ownerB]) {
  for(const table of tables) rows.push({table,record:{id:owner+':'+table,owner_id:owner,day_key:'2026-10-20'}});
  for(const kind of ['pet','timer','summary']) rows.push({table:'badge_projection',record:{id:owner+':'+kind,owner_id:owner,kind,payload:'{}'}});
}
function visible(jwt,{defaults=true,explicit=[],parameters={},subscription={}}={}) {
  const streams=Object.fromEntries(explicit.map(name=>[name,[{opaque_id:0,priorityOverride:null,parameters:subscription}]]));
  const {querier,errors}=config.getBucketParameterQuerier({globalParameters:new RequestParameters(new RequestJwtPayload(jwt),parameters),hasDefaultStreams:defaults,streams});
  assert.deepEqual(errors,[]);assert.equal(querier.hasDynamicBuckets,false);
  const buckets=new Set(querier.staticBuckets.map(b=>b.bucket));
  return rows.flatMap(({table,record})=>config.evaluateRow({sourceTable:{connectionTag:DEFAULT_TAG,schema:'public',name:table},record}).filter(r=>buckets.has(r.bucket)).map(r=>({table:r.table,...r.data})));
}
let passed=0;
function check(name,test){test();passed++;console.log('PASS '+name)}
const request={defaults:false,explicit:['badge_projection']};
check('actual six streams compile',()=>assert.equal(names.length,6));
check('Supabase browser receives own five history tables',()=>{const got=visible(browser);assert.equal(got.length,5);assert.ok(got.every(r=>r.id.startsWith(ownerA)));assert.deepEqual(got.map(r=>r.table).sort(),tables.toSorted())});
check('badge defaults never subscribe history',()=>assert.deepEqual(visible(badge),[]));
check('badge explicit stream receives exactly own3projections',()=>{const got=visible(badge,request);assert.equal(got.length,3);assert.ok(got.every(r=>r.table==='badge_projection'&&r.id.startsWith(ownerA)))});
check('otherowner sees only own projection',()=>assert.ok(visible({...badge,sub:ownerB},request).every(r=>r.id.startsWith(ownerB))));
for(const [name,jwt] of Object.entries({unknownOwner:{...badge,sub:'unknown'},missingIssuer:{sub:ownerA,badge_scope:'v1',device_id:'x'},wrongIssuer:{...badge,iss:'https://bad.invalid'},missingScope:{sub:ownerA,iss:badge.iss,device_id:'x'},nullScope:{...badge,badge_scope:null},wrongScope:{...badge,badge_scope:'v2'},missingDevice:{sub:ownerA,iss:badge.iss,badge_scope:'v1'},browserWithScope:{...browser,badge_scope:'v1',device_id:'x'}}))check(name,()=>assert.deepEqual(visible(jwt,{explicit:names}),[]));
const forged={...browser,sub:ownerB,owner_id:ownerB,badge_scope:null,include_defaults:true};
check('explicit history+forgedparams cannot widen badge access',()=>assert.deepEqual(visible(badge,{explicit:names,parameters:forged,subscription:forged}),visible(badge,request)));
check('browser cannot opt into projection or ownerB',()=>assert.deepEqual(visible(browser,{explicit:names,parameters:{...badge,sub:ownerB},subscription:{...badge,sub:ownerB}}),visible(browser)));
check('missing JWT claims cannot be supplied asparams',()=>assert.deepEqual(visible({sub:ownerA},{explicit:names,parameters:badge,subscription:badge}),[]));
check('history growth cannot increase badge data',()=>{const before=visible(badge,request);for(let i=0;i<1000;i++)rows.push({table:'wellness_events',record:{id:ownerA+':history'+i,owner_id:ownerA}});assert.deepEqual(visible(badge,request),before);assert.equal(visible(browser).length,1005)});
console.log(JSON.stringify({passed,scope:'Actual local policy compile + bucket evaluator; no live service auth assertions.'}));
