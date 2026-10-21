BEGIN;
DO $$
DECLARE o uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid(); pet jsonb; c jsonb; r jsonb; saved jsonb; q jsonb;
 timerid uuid:=gen_random_uuid(); doneid uuid:=gen_random_uuid(); cid uuid; at0 timestamptz:=now()-interval '2 hours'; stamp text;
 n integer; rev text; claim jsonb; ev jsonb; deadline timestamptz; authdata jsonb; prior jsonb;
BEGIN
 INSERT INTO auth.users VALUES(o),(other); INSERT INTO auth.sessions(id,user_id) VALUES(sid,o);
 authdata:=jsonb_build_object('auth_session_id',sid);
 pet:=public.pet_ai_ensure(o,'cat','Cat');
 r:=public.account_gateway('refresh',o,authdata);
 IF r->'timer'->>'state'<>'idle' OR r->'timer'->>'revision'<>'0' THEN RAISE EXCEPTION 'initial timer %',r; END IF;
 IF public.account_gateway('refresh',other,authdata)->>'error'<>'unauthorized' THEN RAISE EXCEPTION 'foreign session accepted'; END IF;
 stamp:=to_char(at0 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 c:=jsonb_build_object('id',gen_random_uuid(),'type','timer_start','occurred_at',stamp,'new_session_id',timerid,'session_type','focus','expected_revision','0');
 r:=public.account_gateway('command',o,authdata||jsonb_build_object('command',c)); saved:=r;
 IF r->>'state'<>'accepted' OR r->>'revision'<>'1' OR r->'timer'->>'last_resumed_at'<>stamp THEN RAISE EXCEPTION 'start failed %',r; END IF;
 IF public.account_gateway('command',o,authdata||jsonb_build_object('command',c))<>saved THEN RAISE EXCEPTION 'receipt changed'; END IF;
 IF private.account_apply(o,c||jsonb_build_object('session_type','break'),'badge')->>'reason'<>'command_id_conflict' THEN RAISE EXCEPTION 'changed id accepted'; END IF;
 IF private.account_apply(o,c||jsonb_build_object('id',gen_random_uuid(),'new_session_id',gen_random_uuid()),'badge')->>'reason'<>'stale_revision' THEN RAISE EXCEPTION 'concurrent start accepted'; END IF;
 c:=jsonb_build_object('id',gen_random_uuid(),'type','timer_pause','session_id',timerid,'expected_revision','1','occurred_at',at0+interval '100 seconds');
 r:=private.account_apply(o,c,'badge');
 IF r->>'revision'<>'2' OR r->'timer'->>'remaining_seconds_at_pause'<>'2300' THEN RAISE EXCEPTION 'offline pause elapsed at upload %',r; END IF;
 c:=jsonb_build_object('id',gen_random_uuid(),'type','timer_resume','session_id',timerid,'expected_revision','2','occurred_at',at0+interval '300 seconds');
 r:=private.account_apply(o,c,'web'); IF r->>'revision'<>'3' OR r->'timer'->>'state'<>'active' THEN RAISE EXCEPTION 'resume %',r; END IF;
 c:=jsonb_build_object('id',doneid,'type','timer_complete','session_id',timerid,'expected_revision','3','occurred_at',at0+interval '2599 seconds');
 IF private.account_apply(o,c,'badge')->>'reason'<>'timer_not_elapsed' THEN RAISE EXCEPTION 'early completion accepted'; END IF;
 -- Rejected receipts are immutable too: a corrected command uses a new id.
 doneid:=gen_random_uuid(); c:=c||jsonb_build_object('id',doneid,'occurred_at',at0+interval '2600 seconds');
 r:=private.account_apply(o,c,'badge');
 IF r->>'revision'<>'4' OR r->'timer'->>'id'<>doneid::text OR r->'timer'->>'state'<>'paused' OR r->'timer'->>'type'<>'break' OR r->'timer'->>'remaining_seconds_at_pause'<>'600' THEN RAISE EXCEPTION 'successor %',r; END IF;
 SELECT count(*) INTO n FROM public.pet_events WHERE owner_id=o;
 q:=private.account_apply(o,c||jsonb_build_object('id',gen_random_uuid()),'web');
 IF q->>'reason'<>'already_completed' OR q->>'revision'<>'4' OR (SELECT count(*) FROM public.pet_events WHERE owner_id=o)<>n THEN RAISE EXCEPTION 'completion duplicated'; END IF;
 IF private.account_apply(o,c,'web')<>r THEN RAISE EXCEPTION 'cross-device retry changed receipt'; END IF;
 c:=jsonb_build_object('id',gen_random_uuid(),'type','timer_resume','session_id',doneid,'expected_revision','4','occurred_at',at0+interval '2700 seconds');
 r:=private.account_apply(o,c,'web'); IF r->>'revision'<>'5' THEN RAISE EXCEPTION 'successor resume %',r; END IF;
 cid:=gen_random_uuid();c:=jsonb_build_object('id',cid,'type','timer_stop','session_id',doneid,'expected_revision','5','occurred_at',at0+interval '2800 seconds');
 r:=private.account_apply(o,c,'badge'); IF r->>'revision'<>'6' OR r->'timer'->>'type'<>'break' OR r->'timer'->>'id'<>cid::text OR r->'timer'->>'state'<>'paused' THEN RAISE EXCEPTION 'stop successor %',r; END IF;
 -- Legacy direct writes advance the head during rollout instead of hiding from CAS.
 UPDATE public.sessions SET remaining_seconds_at_pause=599 WHERE id=cid::text;
 IF private.account_timer(o)->>'revision'<>'7' THEN RAISE EXCEPTION 'legacy revision missing'; END IF;
 c:=jsonb_build_object('id',gen_random_uuid(),'type','hydration','occurred_at',now());
 r:=private.account_apply(o,c,'badge'); IF r->>'state'<>'accepted' OR r->>'revision'<>'7' THEN RAISE EXCEPTION 'water failed'; END IF;
 IF private.account_apply(o,c,'badge')<>r OR (SELECT count(*) FROM public.wellness_events WHERE owner_id=o)<>1 THEN RAISE EXCEPTION 'water duplicate'; END IF;
 c:=jsonb_build_object('id',gen_random_uuid(),'type','pet','pet_session_id',pet->>'id','occurred_at',now());
 r:=private.account_apply(o,c,'web'); IF r->>'state'<>'accepted' THEN RAISE EXCEPTION 'pet failed %',r; END IF;
 SELECT payload::jsonb INTO q FROM public.badge_projection WHERE owner_id=o AND kind='summary';
 IF q->>'pet_count'<>'1' OR q->>'hydration_count'<>'1' THEN RAISE EXCEPTION 'counts %',q; END IF;
 IF (SELECT count(*) FROM public.badge_projection WHERE owner_id=o)<>3 OR EXISTS(SELECT 1 FROM public.badge_projection WHERE octet_length(payload)>1536) THEN RAISE EXCEPTION 'projection bound'; END IF;
 -- No-op refresh does not add history operations.
 SELECT to_jsonb(t) INTO prior FROM (SELECT xmin::text,payload FROM public.badge_projection WHERE owner_id=o AND kind='summary') t;
 PERFORM private.badge_refresh_projection(o);
 IF (SELECT to_jsonb(t) FROM (SELECT xmin::text,payload FROM public.badge_projection WHERE owner_id=o AND kind='summary') t)<>prior THEN RAISE EXCEPTION 'noop refresh rewrote'; END IF;
 -- Worker leases are persistent, fenced and retried after loss of a response.
 claim:=public.pet_ai_claim_next(); ev:=claim->'event';
 IF claim->>'state'<>'claimed' THEN RAISE EXCEPTION 'worker did not claim %',claim; END IF;
 IF public.pet_ai_finish(o,ev->>'id',gen_random_uuid(),'wrong')->>'state'<>'lease_lost' THEN RAISE EXCEPTION 'stale lease committed'; END IF;
 r:=public.pet_ai_finish(o,ev->>'id',(ev->>'lease_token')::uuid,NULL,NULL,true);
 IF r->>'state'<>'retry' OR NOT EXISTS(SELECT 1 FROM public.pet_events WHERE id=ev->>'id' AND status='pending' AND next_attempt_at>now()) THEN RAISE EXCEPTION 'retry not durable'; END IF;
 UPDATE public.pet_events SET status='processing',lease_until=now()-interval '1 second',attempts=7 WHERE id=ev->>'id';
 claim:=public.pet_ai_claim_next();
 IF claim->'event'->>'id'<>ev->>'id' OR claim->'event'->>'attempts'<>'8' THEN RAISE EXCEPTION 'abandoned lease not recovered'; END IF;
 r:=public.pet_ai_finish(o,ev->>'id',(claim->'event'->>'lease_token')::uuid,NULL,NULL,true);
 IF r->>'state'<>'failed' THEN RAISE EXCEPTION 'retry exhaustion not terminal'; END IF;
 -- Changed pet rejects old queued interactions; worker closes stale intents.
 prior:=pet; pet:=public.pet_ai_ensure(o,'otter','Otter',true,gen_random_uuid());
 c:=jsonb_build_object('id',gen_random_uuid(),'type','pet','pet_session_id',prior->>'id','occurred_at',now());
 IF private.account_apply(o,c,'badge')->>'reason'<>'stale_pet_session' THEN RAISE EXCEPTION 'stale pet accepted'; END IF;
 PERFORM public.pet_ai_claim_next();
 IF EXISTS(SELECT 1 FROM public.pet_events WHERE owner_id=o AND pet_session_id=prior->>'id' AND status IN ('pending','processing')) THEN RAISE EXCEPTION 'stale work never terminates'; END IF;
 -- Valid device resolves owner inside SQL and cannot bypass revocation for retry.
 q:=public.badge_gateway('create_pairing',o,authdata||jsonb_build_object('code_hash',repeat('1',64)));
 prior:=public.badge_gateway('claim',NULL,jsonb_build_object('code_hash',repeat('1',64),'pending_hash',repeat('2',64),'credential_hash',repeat('3',64),'verification_id','ABCD-1234'));
 q:=public.badge_gateway('approve_claim',o,authdata||jsonb_build_object('session_id',q->>'session_id','claim_id',prior->>'claim_id'));
 c:=jsonb_build_object('id',gen_random_uuid(),'type','movement','occurred_at',now());
 r:=public.account_gateway('command',NULL,jsonb_build_object('credential_hash',repeat('3',64),'command',c));
 IF r->>'state'<>'accepted' OR NOT EXISTS(SELECT 1 FROM public.wellness_events WHERE id=c->>'id' AND owner_id=o) THEN RAISE EXCEPTION 'device command identity wrong'; END IF;
 PERFORM public.badge_gateway('revoke_device',o,authdata||jsonb_build_object('device_id',q->>'device_id'));
 IF public.account_gateway('command',NULL,jsonb_build_object('credential_hash',repeat('3',64),'command',c))->>'error'<>'unauthorized' THEN RAISE EXCEPTION 'revoked receipt recovery allowed'; END IF;
 -- Reset remains one CAS revision, including idle/no-op resets, and is durable.
 c:=jsonb_build_object('id',gen_random_uuid(),'type','reset_day','expected_revision','7','occurred_at',now(),'day_key',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'));
 r:=private.account_apply(o,c,'web'); IF r->>'revision'<>'8' THEN RAISE EXCEPTION 'reset revision %',r; END IF;
 IF private.account_apply(o,c,'web')<>r THEN RAISE EXCEPTION 'reset repeated'; END IF;
 c:=c||jsonb_build_object('id',gen_random_uuid(),'expected_revision','8');
 IF private.account_apply(o,c,'web')->>'revision'<>'9' THEN RAISE EXCEPTION 'empty reset not acknowledged'; END IF;
 -- Every receipt is private and scoped; another owner cannot recover it.
 IF EXISTS(SELECT 1 FROM private.account_command_receipts WHERE owner_id=other) THEN RAISE EXCEPTION 'owner leaked'; END IF;
END $$;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 BEGIN PERFORM public.account_gateway('refresh',NULL,'{}'); RAISE EXCEPTION 'public RPC allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.pet_ai_claim_next(); RAISE EXCEPTION 'public worker allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM private.account_command_receipts; RAISE EXCEPTION 'receipts exposed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
