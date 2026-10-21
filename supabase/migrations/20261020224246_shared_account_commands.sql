-- Shared commands are additive until the separately reviewed activation step.
-- Private durable receipts and timer revisions never enter PowerSync.
CREATE TABLE private.account_timer_heads (
 owner_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0), last_command_id uuid,
 changing boolean NOT NULL DEFAULT false
);
CREATE TABLE private.account_command_receipts (
 owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
 command_id uuid NOT NULL, command jsonb NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,command_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['account_timer_heads','account_command_receipts'] LOOP
  EXECUTE format('ALTER TABLE private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON private.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT ALL ON private.%I TO service_role',t);
 END LOOP;
END $$;

-- Legacy clients remain usable during staged rollout. Their timer writes advance
-- the same revision, so queued new commands cannot silently overwrite them.
CREATE FUNCTION private.account_timer_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.owner_id ELSE NEW.owner_id END;
BEGIN
 IF TG_OP='UPDATE' AND NEW.owner_id<>OLD.owner_id THEN RAISE EXCEPTION 'owner is immutable'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(o::text,0));
 INSERT INTO private.account_timer_heads(owner_id) VALUES(o) ON CONFLICT DO NOTHING;
 UPDATE private.account_timer_heads SET revision=revision+1,last_command_id=NULL WHERE owner_id=o AND NOT changing;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.account_timer_changed() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER account_timer_revision BEFORE INSERT OR UPDATE OR DELETE ON public.sessions FOR EACH ROW EXECUTE FUNCTION private.account_timer_changed();

CREATE FUNCTION private.account_timer(p_owner uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('revision',coalesce(h.revision,0)::text,'last_command_id',h.last_command_id,
  'id',s.id,'type',coalesce(s.type,'focus'),'state',coalesce(s.state,'idle'),
  'planned_duration_seconds',coalesce(s.planned_duration_seconds,2400),
  'started_at',s.started_at,'last_resumed_at',s.last_resumed_at,'paused_at',s.paused_at,
  'remaining_seconds_at_pause',coalesce(s.remaining_seconds_at_pause,s.planned_duration_seconds,2400))
 FROM (SELECT p_owner AS owner_id) o LEFT JOIN private.account_timer_heads h USING(owner_id)
 LEFT JOIN LATERAL (SELECT * FROM public.sessions WHERE owner_id=p_owner AND state IN ('active','paused') ORDER BY started_at DESC,id DESC LIMIT 1) s ON true;
$$;
REVOKE ALL ON FUNCTION private.account_timer(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.account_timer(uuid) TO service_role;

CREATE OR REPLACE FUNCTION private.badge_refresh_projection(p_owner uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE day text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'); v jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 SELECT jsonb_build_object('id',private.badge_text(p.id,64),'animal_id',private.badge_text(p.animal_id,32),'name',private.badge_text(p.bio_name,40),
 'speech',private.badge_text(p.latest_speech,160),'updated_at',private.badge_text(p.updated_at,32),
 'latest_event_id',private.badge_text(e.id,64),'status',e.status,'error',private.badge_text(e.error_message,40)) INTO v
 FROM public.pet_sessions p LEFT JOIN LATERAL(SELECT id,status,error_message FROM public.pet_events WHERE owner_id=p_owner AND pet_session_id=p.id ORDER BY event_sequence DESC LIMIT 1)e ON true WHERE p.owner_id=p_owner;
 IF v IS NULL THEN DELETE FROM public.badge_projection WHERE owner_id=p_owner AND kind='pet';
 ELSE
 WHILE octet_length(v::text)>1536 AND length(coalesce(v->>'speech',''))>0 LOOP
  v:=jsonb_set(v,'{speech}',to_jsonb(left(v->>'speech',length(v->>'speech')-1)));
 END LOOP;
 INSERT INTO public.badge_projection VALUES(p_owner::text||':pet',p_owner,'pet',v::text)
 ON CONFLICT(owner_id,kind) DO UPDATE SET payload=excluded.payload WHERE badge_projection.payload IS DISTINCT FROM excluded.payload; END IF;
 v:=private.account_timer(p_owner);
 INSERT INTO public.badge_projection VALUES(p_owner::text||':timer',p_owner,'timer',v::text)
 ON CONFLICT(owner_id,kind) DO UPDATE SET payload=excluded.payload WHERE badge_projection.payload IS DISTINCT FROM excluded.payload;
 SELECT jsonb_build_object('day_key',day,
 'ended_focus_count',count(*) FILTER(WHERE type='focus' AND state='ended'),
 'ended_break_count',count(*) FILTER(WHERE type='break' AND state='ended'),
 'completed_focus_count',count(*) FILTER(WHERE type='focus' AND state='ended' AND outcome='completed'),
 'stopped_focus_count',count(*) FILTER(WHERE type='focus' AND state='ended' AND outcome='stopped'),
 'completed_break_count',count(*) FILTER(WHERE type='break' AND state='ended' AND outcome='completed'),
 'stopped_break_count',count(*) FILTER(WHERE type='break' AND state='ended' AND outcome='stopped')) INTO v
 FROM public.sessions WHERE owner_id=p_owner AND day_key=day;
 SELECT v || jsonb_build_object('hydration_count',count(*) FILTER(WHERE type='hydration'),
 'movement_count',count(*) FILTER(WHERE type='movement'),'last_hydration_at',max(occurred_at) FILTER(WHERE type='hydration')) INTO v
 FROM public.wellness_events WHERE owner_id=p_owner AND day_key=day;
 SELECT v || jsonb_build_object('pet_count',count(*)) INTO v FROM public.pet_events WHERE owner_id=p_owner AND event_type='pet_pet' AND left(created_at,10)=day;
 INSERT INTO public.badge_projection VALUES(p_owner::text||':summary',p_owner,'summary',v::text)
 ON CONFLICT(owner_id,kind) DO UPDATE SET payload=excluded.payload WHERE badge_projection.payload IS DISTINCT FROM excluded.payload;
END $$;
CREATE TRIGGER badge_project_pet_event AFTER INSERT OR UPDATE OR DELETE ON public.pet_events FOR EACH ROW EXECUTE FUNCTION private.badge_projection_trigger();

-- The gateway has already authenticated the actor; this function is inaccessible
-- to clients. Commands, domain writes, AI intent and immutable receipt commit once.
CREATE FUNCTION private.account_apply(p_owner uuid,p_command jsonb,p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE cid uuid:=(p_command->>'id')::uuid; kind text:=p_command->>'type';
 r private.account_command_receipts; h private.account_timer_heads; s public.sessions; pet public.pet_sessions;
 result jsonb; reason text; at_time timestamptz; stamp text; session_id text; next_type text;
 remaining integer; live_count integer; event_type text; live_id text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 SELECT * INTO r FROM private.account_command_receipts WHERE owner_id=p_owner AND command_id=cid;
 IF r.command_id IS NOT NULL THEN
  IF r.command=p_command THEN RETURN r.result; END IF;
  RETURN jsonb_build_object('state','rejected','command_id',cid,'reason','command_id_conflict','revision',private.account_timer(p_owner)->>'revision','timer',private.account_timer(p_owner));
 END IF;
 INSERT INTO private.account_timer_heads(owner_id) VALUES(p_owner) ON CONFLICT DO NOTHING;
 SELECT * INTO h FROM private.account_timer_heads WHERE owner_id=p_owner FOR UPDATE;
 at_time:=(p_command->>'occurred_at')::timestamptz;
 IF at_time IS NULL OR at_time<now()-interval '30 days' OR at_time>now()+interval '5 minutes' THEN reason:='invalid_time'; END IF;
 IF EXISTS(SELECT 1 FROM public.pet_events WHERE id=cid::text) THEN reason:='event_id_conflict'; END IF;
 -- Small permitted clock skew never creates a timer in the future.
 at_time:=least(at_time,now());
 stamp:=to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 SELECT * INTO pet FROM public.pet_sessions WHERE owner_id=p_owner FOR UPDATE;
 IF kind LIKE 'timer_%' OR kind='reset_day' THEN
  SELECT count(*) INTO live_count FROM public.sessions WHERE owner_id=p_owner AND state IN ('active','paused');
  SELECT * INTO s FROM public.sessions WHERE owner_id=p_owner AND state IN ('active','paused') ORDER BY started_at DESC,id DESC LIMIT 1 FOR UPDATE;
  IF live_count>1 THEN reason:='timer_ambiguous';
  ELSIF kind='timer_complete' AND EXISTS(SELECT 1 FROM public.sessions WHERE owner_id=p_owner AND id=p_command->>'session_id' AND state='ended' AND outcome='completed') THEN
   -- A second device finishing the same phase cannot create a second successor or reaction.
   reason:='already_completed';
  ELSIF p_command->>'expected_revision' IS DISTINCT FROM h.revision::text THEN reason:='stale_revision';
  ELSIF kind='timer_start' AND s.id IS NOT NULL THEN reason:='timer_exists';
  ELSIF kind NOT IN ('timer_start','reset_day') AND s.id IS DISTINCT FROM p_command->>'session_id' THEN reason:='session_not_current';
  ELSIF s.id IS NOT NULL AND at_time<greatest(s.last_resumed_at::timestamptz,coalesce(s.paused_at,s.started_at)::timestamptz) AND kind<>'reset_day' THEN reason:='out_of_order';
  END IF;
  IF reason IS NULL THEN
   remaining:=coalesce(s.remaining_seconds_at_pause,s.planned_duration_seconds);
   IF s.state='active' THEN remaining:=greatest(0,remaining-floor(extract(epoch FROM(at_time-s.last_resumed_at::timestamptz)))::integer); END IF;
   IF kind='timer_pause' AND (s.state<>'active' OR remaining=0) THEN reason:='timer_not_running';
   ELSIF kind='timer_resume' AND s.state<>'paused' THEN reason:='timer_not_paused';
   ELSIF kind='timer_complete' AND (s.state<>'active' OR remaining>0) THEN reason:='timer_not_elapsed'; END IF;
  END IF;
  IF reason IS NULL THEN
   session_id:=CASE WHEN kind='timer_start' THEN p_command->>'new_session_id' ELSE cid::text END;
   IF kind IN ('timer_start','timer_complete','timer_stop') AND EXISTS(SELECT 1 FROM public.sessions WHERE id=session_id) THEN reason:='session_id_conflict'; END IF;
  END IF;
  IF reason IS NULL THEN
   UPDATE private.account_timer_heads SET changing=true WHERE owner_id=p_owner;
   IF kind='timer_start' THEN
    next_type:=p_command->>'session_type';
    INSERT INTO public.sessions(id,owner_id,day_key,type,planned_duration_seconds,state,started_at,last_resumed_at,remaining_seconds_at_pause)
     VALUES(session_id,p_owner,left(stamp,10),next_type,CASE WHEN next_type='focus' THEN 2400 ELSE 600 END,'active',stamp,stamp,CASE WHEN next_type='focus' THEN 2400 ELSE 600 END);
    event_type:=CASE WHEN next_type='focus' THEN 'start_focus_session' ELSE 'start_break' END;
   ELSIF kind='timer_pause' THEN
    UPDATE public.sessions SET state='paused',paused_at=stamp,remaining_seconds_at_pause=remaining WHERE id=s.id;
    IF s.type='focus' THEN event_type:='pause_focus_session'; END IF;
   ELSIF kind='timer_resume' THEN
    UPDATE public.sessions SET state='active',last_resumed_at=stamp,paused_at=NULL WHERE id=s.id;
    event_type:=CASE WHEN s.type='focus' THEN 'resume_focus_session' ELSE 'start_break' END;
   ELSIF kind IN ('timer_complete','timer_stop') THEN
    UPDATE public.sessions SET state='ended',ended_at=stamp,outcome=CASE WHEN kind='timer_complete' THEN 'completed' ELSE 'stopped' END,remaining_seconds_at_pause=remaining WHERE id=s.id;
    next_type:=CASE WHEN kind='timer_stop' THEN s.type WHEN s.type='focus' THEN 'break' ELSE 'focus' END;
    INSERT INTO public.sessions(id,owner_id,day_key,type,planned_duration_seconds,state,started_at,last_resumed_at,paused_at,remaining_seconds_at_pause)
     VALUES(session_id,p_owner,left(stamp,10),next_type,CASE WHEN next_type='focus' THEN 2400 ELSE 600 END,'paused',stamp,stamp,stamp,CASE WHEN next_type='focus' THEN 2400 ELSE 600 END);
    event_type:=CASE WHEN kind='timer_complete' THEN CASE WHEN s.type='focus' THEN 'complete_focus_session' ELSE 'complete_break' END ELSE CASE WHEN s.type='focus' THEN 'stop_focus_session_early' ELSE 'stop_break_early' END END;
   ELSIF kind='reset_day' THEN
    DELETE FROM public.sessions WHERE owner_id=p_owner AND day_key=p_command->>'day_key';
    DELETE FROM public.wellness_events WHERE owner_id=p_owner AND day_key=p_command->>'day_key';
    DELETE FROM public.daily_activity_summary WHERE owner_id=p_owner AND day_key=p_command->>'day_key';
    DELETE FROM public.pet_events WHERE owner_id=p_owner AND left(created_at,10)=p_command->>'day_key';
   ELSE RAISE EXCEPTION 'unsupported timer command'; END IF;
   UPDATE private.account_timer_heads SET changing=false,revision=revision+1,last_command_id=cid WHERE owner_id=p_owner;
  END IF;
 ELSIF kind IN ('hydration','movement') AND reason IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.wellness_events WHERE id=cid::text) THEN reason:='event_id_conflict';
  ELSE INSERT INTO public.wellness_events(id,owner_id,day_key,type,occurred_at) VALUES(cid::text,p_owner,left(stamp,10),kind,stamp);
   event_type:=CASE WHEN kind='hydration' THEN 'drink_water' ELSE 'move_or_stretch' END; END IF;
 ELSIF kind='pet' AND reason IS NULL THEN
  IF pet.id IS NULL OR pet.id IS DISTINCT FROM p_command->>'pet_session_id' THEN reason:='stale_pet_session'; ELSE event_type:='pet_pet'; END IF;
 ELSIF reason IS NULL THEN reason:='invalid_command'; END IF;
 IF reason IS NULL AND event_type IS NOT NULL AND pet.id IS NOT NULL THEN
  INSERT INTO public.pet_events(id,owner_id,pet_session_id,event_type,source_device,created_at) VALUES(cid::text,p_owner,pet.id,event_type,p_source,stamp);
 END IF;
 PERFORM private.badge_refresh_projection(p_owner);
 result:=jsonb_build_object('state',CASE WHEN reason IS NULL OR reason='already_completed' THEN 'accepted' ELSE 'rejected' END,
  'command_id',cid,'revision',private.account_timer(p_owner)->>'revision','timer',private.account_timer(p_owner));
 IF reason IS NOT NULL THEN result:=result||jsonb_build_object('reason',reason); END IF;
 INSERT INTO private.account_command_receipts(owner_id,command_id,command,result) VALUES(p_owner,cid,p_command,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION private.account_apply(uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.account_apply(uuid,jsonb,text) TO service_role;

CREATE FUNCTION public.account_gateway(p_action text,p_owner uuid DEFAULT NULL,p_data jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE cr private.badge_credentials; d private.badge_devices; source text:='web'; oid uuid; result jsonb;
BEGIN
 IF p_owner IS NOT NULL THEN
  IF NOT private.badge_owner_session(p_owner,(p_data->>'auth_session_id')::uuid) THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
 ELSE
  source:='badge';
  SELECT * INTO cr FROM private.badge_credentials WHERE credential_hash=p_data->>'credential_hash';
  IF cr.device_id IS NULL OR cr.state<>'active' OR cr.expires_at<=now() THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  SELECT owner_id INTO oid FROM private.badge_devices WHERE id=cr.device_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(oid::text,0));
  SELECT * INTO d FROM private.badge_devices WHERE id=cr.device_id FOR UPDATE;
  SELECT * INTO cr FROM private.badge_credentials WHERE credential_hash=p_data->>'credential_hash' FOR UPDATE;
  IF d.state<>'active' OR cr.state<>'active' OR cr.expires_at<=now() THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  UPDATE private.badge_devices SET last_seen_at=now() WHERE id=d.id;
  p_owner:=d.owner_id;
 END IF;
 IF p_action='command' THEN RETURN private.account_apply(p_owner,p_data->'command',source);
 ELSIF p_action='refresh' THEN
  PERFORM private.badge_refresh_projection(p_owner);
  SELECT jsonb_object_agg(kind,payload::jsonb) INTO result FROM public.badge_projection WHERE owner_id=p_owner;
  RETURN result;
 END IF;
 RETURN jsonb_build_object('error','invalid_action');
END $$;
REVOKE ALL ON FUNCTION public.account_gateway(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_gateway(text,uuid,jsonb) TO service_role;

-- Durable inference retries survive lost responses and function restarts.
ALTER TABLE public.pet_events ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX pet_events_due ON public.pet_events(next_attempt_at,event_sequence) WHERE status IN ('pending','processing');
CREATE OR REPLACE FUNCTION public.pet_ai_claim(
    p_owner_id UUID, p_id TEXT, p_pet_session_id TEXT, p_event_type TEXT,
    p_source_device TEXT, p_created_at TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    pet public.pet_sessions;
    event public.pet_events;
    stamp TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_id::text,0));
    SELECT * INTO pet FROM public.pet_sessions WHERE owner_id = p_owner_id FOR UPDATE;
    IF pet.id IS NULL OR pet.id <> p_pet_session_id THEN
        RETURN jsonb_build_object('state', 'rejected', 'reason', 'stale_pet_session');
    END IF;
    INSERT INTO public.pet_events(id, owner_id, pet_session_id, event_type, source_device, created_at)
        VALUES (p_id, p_owner_id, p_pet_session_id, p_event_type, p_source_device, p_created_at)
        ON CONFLICT (id) DO NOTHING;
    SELECT * INTO event FROM public.pet_events WHERE id = p_id FOR UPDATE;
    IF event.owner_id <> p_owner_id OR event.pet_session_id <> p_pet_session_id
        OR event.event_type <> p_event_type OR event.source_device <> p_source_device
        OR event.created_at <> p_created_at THEN
        RETURN jsonb_build_object('state', 'rejected', 'reason', 'event_id_conflict');
    END IF;
    IF event.status IN ('completed', 'failed') THEN
        RETURN jsonb_build_object('state', event.status, 'event', to_jsonb(event));
    END IF;
    IF event.status = 'pending' AND event.next_attempt_at > now() THEN
        RETURN jsonb_build_object('state', 'busy');
    END IF;
    IF event.status = 'processing' AND event.lease_until > now() THEN
        RETURN jsonb_build_object('state', 'busy');
    END IF;
    -- Per-owner budget bounds authenticated clients; duplicates don't consume it.
    IF (SELECT count(*) FROM public.pet_events WHERE owner_id = p_owner_id
        AND claimed_at::timestamptz > now() - interval '1 hour') >= 120
        AND event.attempts = 0 THEN
        RETURN jsonb_build_object('state', 'busy');
    END IF;
    UPDATE public.pet_events SET status = 'processing',
        lease_token = gen_random_uuid(), lease_until = now() + interval '90 seconds',
        claimed_at = stamp, attempts = attempts + 1
        WHERE id = p_id RETURNING * INTO event;
    RETURN jsonb_build_object('state', 'claimed', 'event', to_jsonb(event), 'pet', to_jsonb(pet));
END;
$$;

CREATE OR REPLACE FUNCTION public.pet_ai_finish(
    p_owner_id UUID, p_id TEXT, p_lease_token UUID,
    p_speech TEXT DEFAULT NULL, p_error TEXT DEFAULT NULL, p_retry BOOLEAN DEFAULT false
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    event public.pet_events;
    stamp TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_id::text,0));
    -- Owner, pet, then event is the shared lock order.
    PERFORM 1 FROM public.pet_sessions WHERE owner_id = p_owner_id FOR UPDATE;
    SELECT * INTO event FROM public.pet_events WHERE id = p_id AND owner_id = p_owner_id FOR UPDATE;
    IF event.id IS NULL OR event.lease_token IS DISTINCT FROM p_lease_token
        OR event.status <> 'processing' THEN
        RETURN jsonb_build_object('state', 'lease_lost');
    END IF;
    IF p_retry AND event.attempts < 8 THEN
        UPDATE public.pet_events SET status = 'pending', lease_token = NULL, lease_until = NULL,
            next_attempt_at=now()+make_interval(secs=>least(3600,60*(2^least(event.attempts,6))::integer))
            WHERE id = p_id;
        RETURN jsonb_build_object('state', 'retry');
    ELSIF p_retry THEN p_error:='Your pet could not reply after repeated attempts.'; p_speech:=NULL; END IF;
    IF p_error IS NULL AND (p_speech IS NULL OR length(p_speech) = 0 OR length(p_speech) > 240) THEN
        RAISE EXCEPTION 'invalid speech';
    END IF;
    UPDATE public.pet_events SET status = CASE WHEN p_error IS NULL THEN 'completed' ELSE 'failed' END,
        reaction_speech = p_speech, error_message = p_error, completed_at = stamp,
        lease_token = NULL, lease_until = NULL
        WHERE id = p_id RETURNING * INTO event;
    -- Global server sequence orders arrivals; clocks on devices cannot reorder state.
    -- Session match prevents pre-reset requests from replacing the new pet.
    UPDATE public.pet_sessions SET latest_event_id = event.id,
        latest_event_sequence = event.event_sequence,
        latest_speech = coalesce(p_speech, latest_speech), last_error = p_error, updated_at = stamp
        WHERE owner_id = p_owner_id AND id = event.pet_session_id
        AND latest_event_sequence < event.event_sequence;
    RETURN jsonb_build_object('state', event.status, 'event', to_jsonb(event));
END;
$$;


CREATE FUNCTION public.pet_ai_claim_next() RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE e public.pet_events; v jsonb;
BEGIN
 FOR e IN SELECT * FROM public.pet_events WHERE (status='pending' AND next_attempt_at<=now()) OR (status='processing' AND lease_until<=now()) ORDER BY event_sequence LIMIT 20 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended(e.owner_id::text,0)) THEN CONTINUE; END IF;
  v:=public.pet_ai_claim(e.owner_id,e.id,e.pet_session_id,e.event_type,e.source_device,e.created_at);
  IF v->>'state'='claimed' THEN RETURN v; END IF;
  IF v->>'state'='rejected' THEN
   UPDATE public.pet_events SET status='failed',error_message='Pet changed before this reaction.',lease_token=NULL,lease_until=NULL WHERE id=e.id AND status IN ('pending','processing');
  END IF;
 END LOOP;
 RETURN jsonb_build_object('state','empty');
END $$;
REVOKE ALL ON FUNCTION public.pet_ai_claim_next() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pet_ai_claim_next() TO service_role;
DO $$ DECLARE o uuid; BEGIN
 FOR o IN SELECT owner_id FROM public.pet_sessions UNION SELECT owner_id FROM public.sessions UNION SELECT owner_id FROM public.wellness_events LOOP PERFORM private.badge_refresh_projection(o); END LOOP;
END $$;
