#!/usr/bin/env python3
"""Synthetic host-only sizing fixture; no transport, service, badge or backup access."""
import argparse
import tempfile
import ctypes as c
import hashlib
import faulthandler
faulthandler.enable()
import json
import os
from pathlib import Path
import sys
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('mode', choices=('canonical', 'projection_only', 'compact_safe', 'compact_boundary', 'compact_churn_repro'))
parser.add_argument('--allow-native-crash', action='store_true', help='Explicitly enable known-crashing HOST-ONLY full-capacity modes')
parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--output-dir', type=Path)
args = parser.parse_args()
if args.mode in ('compact_boundary', 'compact_churn_repro') and not args.allow_native_crash:
    parser.error('Full-capacity tests can crash Python; explicit --allow-native-crash is required. Use compact_safe for bounded measurements.')
REPO = args.repo.resolve()
OUT = args.output_dir.resolve() if args.output_dir else Path(tempfile.mkdtemp(prefix='badge-pairing-capacity-'))
OUT.mkdir(parents=True, exist_ok=True)
print('OUTPUT_DIRECTORY', str(OUT), flush=True)
sys.dont_write_bytecode = True
sys.path.insert(0, str(REPO / 'badge/tests'))
from test_storage import HostCore, HOST_LIBRARY

MODE = args.mode
DB = OUT / ('capacity-' + MODE + '.sqlite')
if DB.exists():
    raise SystemExit('Refusing to overwrite fixture database')
core = HostCore()
lib = core.library
lib.sqlite3_memory_used.restype = c.c_int64
lib.sqlite3_memory_used.argtypes = []
lib.sqlite3_memory_highwater.restype = c.c_int64
lib.sqlite3_memory_highwater.argtypes = [c.c_int]
core.open(str(DB))
max_journal = 0
max_sql_bytes = 0
max_wire_bytes = 0
stage = 'open'

def quote(value):
    return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"

def compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True)

def execute(sql):
    global max_journal, max_sql_bytes
    max_sql_bytes = max(max_sql_bytes, len(sql.encode()))
    (OUT / ('capacity-'+MODE+'-last-sql.txt')).write_text(sql)
    rows = core.exec(sql)
    if len(rows) > 32:
        raise ValueError('Would exceed device wrapper 32-row output cap')
    journal = Path(str(DB) + '-journal')
    if journal.exists():
        max_journal = max(max_journal, journal.stat().st_size)
    return rows

def scalar(sql):
    result = execute(sql)
    assert len(result) == 1 and len(result[0]) == 1
    return result[0][0]

def emit(label, **extra):
    data = {'stage': label, 'mode': MODE,
            'db_bytes': DB.stat().st_size,
            'pages': int(scalar('PRAGMA page_count')),
            'freelist_pages': int(scalar('PRAGMA freelist_count')),
            'arena_used': lib.sqlite3_memory_used(),
            'arena_highwater': lib.sqlite3_memory_highwater(0),
            'journal_sampled_max': max_journal,
            'max_sql_bytes': max_sql_bytes,
            'max_wire_line_bytes': max_wire_bytes,
            **extra}
    print(compact(data), flush=True)

def transaction(callback):
    execute('BEGIN IMMEDIATE')
    try:
        result = callback()
        execute('COMMIT')
        return result
    except Exception:
        try:
            execute('ROLLBACK')
        except Exception:
            pass
        raise

def control(command, payload=None):
    return transaction(lambda: scalar('SELECT powersync_control(%s,%s)' % (quote(command),quote(payload))))

def line(payload):
    global max_wire_bytes
    text = compact(payload)
    max_wire_bytes = max(max_wire_bytes, len(text.encode()))
    return control('line_text', text)

def table(name, text=(), integers=(), local=False):
    value={'name':name,'columns':[{'name':key,'type':'text'} for key in text] + [{'name':key,'type':'integer'} for key in integers]}
    if local:
        value['local_only']=True
    return value

schema={'tables':[
 table('badge_state', ['snapshot'], local=True),
 table('sessions', ['day_key','type','state','outcome','started_at','last_resumed_at','paused_at','ended_at'], ['planned_duration_seconds','remaining_seconds_at_pause','revision']),
 table('wellness_events', ['day_key','type','occurred_at']),
 table('pet_sessions', ['animal_id','bio_name','bio_summary','latest_speech','latest_event_id','last_error','created_at','updated_at']),
 table('pet_events', ['pet_session_id','event_type','source_device','status','reaction_speech','error_message','created_at','claimed_at','completed_at']),
 table('badge_daily_summary', ['day_key','last_hydration_at','updated_at'], ['completed_focus_count','stopped_focus_count','completed_break_count','stopped_break_count','hydration_count','movement_count']),
 table('badge_recent_activity', ['event_id','day_key','kind','occurred_at','label'], ['slot']),
]}
if MODE.startswith('compact'):
    # Alternative shape only: explicitly projected payload rows and outgoing commands.
    # Does not sync the legacy aggregate snapshot into canonical web tables.
    schema={'tables':[
        table('badge_state',['snapshot'],local=True),
        table('badge_projection',['kind','payload']),
        table('badge_commands',['command_id','kind','payload','created_at'],['expected_revision'])
    ]}

if MODE == 'projection_only':
    schema['tables']=[item for item in schema['tables'] if item['name'] not in ('wellness_events','pet_events')]

try:
    for sql in ['PRAGMA page_size=1024','PRAGMA max_page_count=128','PRAGMA cache_size=8','PRAGMA temp_store=MEMORY','PRAGMA synchronous=FULL','PRAGMA journal_mode=DELETE']:
        execute(sql)
    emit('empty_core', sqlite=scalar('SELECT sqlite_version()'), powersync=scalar('SELECT powersync_rs_version()'), library_sha256=hashlib.sha256(HOST_LIBRARY.read_bytes()).hexdigest())
    stage='schema'
    transaction(lambda:scalar('SELECT powersync_replace_schema(%s)' % quote(compact(schema))))
    emit('schema', schema_tables=len(schema['tables']))
    legacy={'phase':'focus','remaining_ms':2243961,'running':False,'focus_count':0,'water_count':1,'stretch_count':1,'pet_count':6,'clock_saved_s':None}
    def save_local():
        for key,payload in [('legacy',compact(legacy)),('identity',compact({'owner_id':'a'*36,'device_id':'b'*36,'generation':1,'state':'paired'})),('retry',compact({'transaction_id':'c'*36,'owner_id':'a'*36,'device_id':'b'*36,'first_id':0,'last_id':0,'payload_digest':'d'*64,'status':'idle'}))]:
            execute('INSERT INTO badge_state(id,snapshot) VALUES(%s,%s)' % (quote(key),quote(payload)))
    transaction(save_local)
    stamp='2026-10-20T20:00:00.000Z'
    pet_id='11111111-1111-4111-8111-111111111111'
    session_id='22222222-2222-4222-8222-222222222222'
    rows=[('pet_sessions',pet_id,{'animal_id':'capybara','bio_name':'N'*32,'bio_summary':'B'*160,'latest_speech':'S'*240,'latest_event_id':'33333333-3333-4333-8333-333333333333','last_error':'E'*80,'created_at':stamp,'updated_at':stamp}),
          ('sessions',session_id,{'day_key':'2026-10-20','type':'focus','planned_duration_seconds':2400,'state':'active','outcome':None,'started_at':stamp,'last_resumed_at':stamp,'paused_at':None,'ended_at':None,'remaining_seconds_at_pause':None,'revision':1}),
          ('badge_daily_summary','2026-10-20',{'day_key':'2026-10-20','completed_focus_count':9,'stopped_focus_count':4,'completed_break_count':9,'stopped_break_count':4,'hydration_count':99,'movement_count':99,'last_hydration_at':stamp,'updated_at':stamp})]
    for i in range(8):
        rows.append(('badge_recent_activity','recent-%d'%i,{'slot':i,'event_id':str(uuid.UUID(int=500+i)),'day_key':'2026-10-20','kind':'hydration','occurred_at':stamp,'label':'L'*48}))
    if MODE.startswith('compact'):
        rows=[('badge_projection',row_id,{'kind':table_name,'payload':compact(payload)}) for table_name,row_id,payload in rows]
    stage='checkpoint'
    assert 'EstablishSyncStream' in control('start','{"checkpoint_mode":"requests"}')
    control('seed_checkpoint_request_id','1')
    count=len(rows)
    line({'checkpoint':{'last_op_id':str(count),'write_checkpoint':'1','buckets':[{'bucket':'host-sizing-only','checksum':count,'priority':3,'count':count}]}})
    # One synthetic op per line avoids treating an artificially huge chunk as needed.
    for i,(table_name,row_id,payload) in enumerate(rows,1):
        line({'data':{'bucket':'host-sizing-only','has_more':i<count,'after':None if i==1 else str(i-1),'next_after':str(i),'data':[{'op_id':str(i),'op':'PUT','object_type':table_name,'object_id':row_id,'checksum':1,'data':compact(payload)}]}})
    completed=line({'checkpoint_complete':{'last_op_id':str(count)}})
    assert 'DidCompleteSync' in completed, completed
    assert scalar('SELECT count(*) FROM ps_crud') == '0'
    assert scalar('SELECT count(*) FROM ps_oplog') == str(count)
    emit('checkpoint_published', checkpoint_result=completed, oplog_rows=count)
    if MODE == 'projection_only':
        emit('projection_only_complete', integrity=scalar('PRAGMA integrity_check'))
        raise SystemExit(0)
    if MODE in ('compact_churn','compact_churn_repro','compact_safe'):
        stage='checkpoint_churn'
        for cycle in range(1,101):
            last=count*(cycle+1)
            line({'checkpoint':{'last_op_id':str(last),'write_checkpoint':'1','buckets':[{'bucket':'host-sizing-only','checksum':last,'priority':3,'count':last}]}})
            for i,(table_name,row_id,payload) in enumerate(rows,1):
                op_id=count*cycle+i
                value=dict(payload)
                value['payload']=value['payload'].replace('L'*48,chr(65+cycle%26)*48)
                line({'data':{'bucket':'host-sizing-only','has_more':i<count,'after':str(op_id-1),'next_after':str(op_id),'data':[{'op_id':str(op_id),'op':'PUT','object_type':table_name,'object_id':row_id,'checksum':1,'data':compact(value)}]}})
            completed=line({'checkpoint_complete':{'last_op_id':str(last)}})
            assert 'DidCompleteSync' in completed, completed
            assert scalar('SELECT count(*) FROM ps_oplog')==str(count)
            if cycle in [1,10,100]:
                emit('checkpoint_churn_%d'%cycle, oplog_rows=count)
    accepted=0
    stage='outbox'
    for n in range(1,33 if MODE == 'compact_safe' else 97):
        if n >= 64:
            print(compact({'stage':'about_to_enqueue','mode':MODE,'action':n}),flush=True)
        wellness_id=str(uuid.UUID(int=1000+n))
        reaction_id=str(uuid.UUID(int=2000+n))
        def enqueue():
            if MODE == 'canonical':
                execute('INSERT INTO wellness_events(id,day_key,type,occurred_at) VALUES(%s,\'2026-10-20\',\'hydration\',%s)'%(quote(wellness_id),quote(stamp)))
                execute('INSERT INTO pet_events(id,pet_session_id,event_type,source_device,status,created_at) VALUES(%s,%s,\'drink_water\',\'badge\',\'pending\',%s)'%(quote(reaction_id),quote(pet_id),quote(stamp)))
            else:
                payload=compact({'wellness_id':wellness_id,'day_key':'2026-10-20','occurred_at':stamp,'type':'hydration','pet_session_id':pet_id,'pet_event_id':reaction_id})
                execute('INSERT INTO badge_commands(id,command_id,kind,payload,created_at,expected_revision) VALUES(%s,%s,\'log_hydration\',%s,%s,NULL)'%(quote(wellness_id),quote(wellness_id),quote(payload),quote(stamp)))
        try:
            transaction(enqueue)
            accepted=n
            if n in [1,8,16,24,32,48,64,65,66,67,80,96]:
                emit('outbox_%d'%n, local_actions=n, crud_rows=int(scalar('SELECT count(*) FROM ps_crud')))
            if n==8:
                # Persist exactly the first local transaction and retry metadata.
                capture=execute('SELECT id,tx_id,data FROM ps_crud ORDER BY id LIMIT 2' if MODE=='canonical' else 'SELECT id,tx_id,data FROM ps_crud ORDER BY id LIMIT 1')
                payload=compact({'owner_id':'a'*36,'device_id':'b'*36,'transaction_id':'c'*36,'first_id':capture[0][0],'last_id':capture[-1][0],'payload_digest':hashlib.sha256(compact(capture).encode()).hexdigest(),'crud':capture,'status':'pending'})
                transaction(lambda:execute('UPDATE badge_state SET snapshot=%s WHERE id=\'retry\''%quote(payload)))
                emit('captured_upload', capture_bytes=len(payload.encode()))
        except Exception as error:
            emit('outbox_capacity_error', local_actions=accepted, error=str(error), crud_rows=int(scalar('SELECT count(*) FROM ps_crud')))
            break
    stage='close_reopen'
    control('stop')
    before=(scalar('SELECT count(*) FROM ps_crud'),scalar('SELECT count(*) FROM ps_oplog'))
    core.close()
    core.open(str(DB))
    execute('PRAGMA cache_size=8')
    execute('PRAGMA temp_store=MEMORY')
    after=(scalar('SELECT count(*) FROM ps_crud'),scalar('SELECT count(*) FROM ps_oplog'))
    assert before==after
    emit('reopened', integrity=scalar('PRAGMA integrity_check'), crud_rows=int(after[0]), oplog_rows=int(after[1]), local_actions=accepted)
except Exception as error:
    print(compact({'stage':stage,'mode':MODE,'error':str(error),'arena_used':lib.sqlite3_memory_used(),'arena_highwater':lib.sqlite3_memory_highwater(0),'db_bytes':DB.stat().st_size,'journal_sampled_max':max_journal}),flush=True)
    raise
finally:
    core.close()
