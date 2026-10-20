-- Refuse a publication that would replicate credentials from private tables.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='powersync' AND puballtables) THEN RAISE EXCEPTION 'powersync publication must list explicit public tables'; END IF; END $$;
-- Device credentials never enter public tables or PowerSync replication.
CREATE TABLE private.badge_pairing_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
 code_hash text NOT NULL CHECK(length(code_hash)=64), state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','delivered','cancelled','expired','revoked')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes', approved_claim_id uuid,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX badge_pairing_code_active ON private.badge_pairing_sessions(code_hash) WHERE state='pending';
CREATE UNIQUE INDEX badge_pairing_owner_active ON private.badge_pairing_sessions(owner_id) WHERE state='pending';
CREATE TABLE private.badge_pending_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES private.badge_pairing_sessions ON DELETE CASCADE,
 pending_hash text UNIQUE NOT NULL CHECK(length(pending_hash)=64), credential_hash text UNIQUE NOT NULL CHECK(length(credential_hash)=64),
 verification_id text NOT NULL CHECK(verification_id ~ '^[A-F0-9]{4}-[A-F0-9]{4}$'), state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(), recovery_until timestamptz NOT NULL DEFAULT now()+interval '1 day', device_id uuid
);
CREATE TABLE private.badge_devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
 claim_id uuid UNIQUE NOT NULL REFERENCES private.badge_pending_claims,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 40), state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
 paired_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz, revoked_at timestamptz
);
CREATE TABLE private.badge_credentials (
 credential_hash text PRIMARY KEY CHECK(length(credential_hash)=64), device_id uuid NOT NULL REFERENCES private.badge_devices ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '180 days'
);
CREATE TABLE private.badge_rate_windows (
 scope text NOT NULL, subject_hash text NOT NULL, bucket timestamptz NOT NULL, hits integer NOT NULL,
 PRIMARY KEY(scope,subject_hash,bucket)
);
CREATE TABLE private.badge_upload_receipts (
 owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE, device_id uuid NOT NULL REFERENCES private.badge_devices ON DELETE CASCADE,
 request_id uuid NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,device_id,request_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['badge_pairing_sessions','badge_pending_claims','badge_devices','badge_credentials','badge_rate_windows','badge_upload_receipts'] LOOP
  EXECUTE format('ALTER TABLE private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON private.%I FROM PUBLIC, anon, authenticated',t);
  EXECUTE format('GRANT ALL ON private.%I TO service_role',t);
 END LOOP;
END $$;

-- One compact client table: exactly three allowed slots per owner, with a hard
-- encoded payload ceiling. Full event history remains in canonical tables.
CREATE TABLE public.badge_projection (
 id text PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('pet','timer','summary')),
 payload text NOT NULL CHECK(octet_length(payload)<=1536),
 UNIQUE(owner_id,kind), CHECK(id=owner_id::text||':'||kind)
);
ALTER TABLE public.badge_projection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.badge_projection FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.badge_projection TO authenticated;
GRANT ALL ON public.badge_projection TO service_role;
CREATE POLICY badge_projection_owner_read ON public.badge_projection FOR SELECT TO authenticated USING(owner_id=(select auth.uid()));
ALTER TABLE public.badge_projection REPLICA IDENTITY FULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_publication WHERE pubname='powersync') THEN CREATE PUBLICATION powersync; END IF;
 IF NOT (SELECT puballtables FROM pg_publication WHERE pubname='powersync') THEN ALTER PUBLICATION powersync ADD TABLE public.badge_projection; END IF;
END $$;

-- Remove JSON-escaped controls before truncation so multibyte text has a
-- predictable encoded ceiling without rejecting valid canonical writes.
CREATE FUNCTION private.badge_text(p_value text,p_chars integer) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$ SELECT left(regexp_replace(p_value,'[[:cntrl:]]','','g'),p_chars) $$;
REVOKE ALL ON FUNCTION private.badge_text(text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.badge_text(text,integer) TO service_role;

CREATE FUNCTION private.badge_refresh_projection(p_owner uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE day text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'); v jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 SELECT jsonb_build_object('id',private.badge_text(id,64),'animal_id',private.badge_text(animal_id,32),'name',private.badge_text(bio_name,40),
 'speech',private.badge_text(latest_speech,160),'updated_at',private.badge_text(updated_at,32)) INTO v FROM public.pet_sessions WHERE owner_id=p_owner;
 IF v IS NULL THEN DELETE FROM public.badge_projection WHERE owner_id=p_owner AND kind='pet';
 ELSE INSERT INTO public.badge_projection VALUES(p_owner::text||':pet',p_owner,'pet',v::text)
 ON CONFLICT(owner_id,kind) DO UPDATE SET payload=excluded.payload; END IF;
 SELECT jsonb_build_object('id',private.badge_text(id,64),'type',type,'state',state,'planned_duration_seconds',planned_duration_seconds,
 'started_at',private.badge_text(started_at,32),'last_resumed_at',private.badge_text(last_resumed_at,32),'paused_at',private.badge_text(paused_at,32),
 'remaining_seconds_at_pause',remaining_seconds_at_pause) INTO v
 FROM public.sessions WHERE owner_id=p_owner AND state IN ('active','paused') ORDER BY started_at DESC,id DESC LIMIT 1;
 IF v IS NULL THEN DELETE FROM public.badge_projection WHERE owner_id=p_owner AND kind='timer';
 ELSE INSERT INTO public.badge_projection VALUES(p_owner::text||':timer',p_owner,'timer',v::text)
 ON CONFLICT(owner_id,kind) DO UPDATE SET payload=excluded.payload; END IF;
 SELECT jsonb_build_object('day_key',day,
 'completed_focus_count',count(*) FILTER(WHERE type='focus' AND state='ended' AND outcome='completed'),
 'stopped_focus_count',count(*) FILTER(WHERE type='focus' AND state='ended' AND outcome='stopped'),
 'completed_break_count',count(*) FILTER(WHERE type='break' AND state='ended' AND outcome='completed'),
 'stopped_break_count',count(*) FILTER(WHERE type='break' AND state='ended' AND outcome='stopped')) INTO v
 FROM public.sessions WHERE owner_id=p_owner AND day_key=day;
 SELECT v || jsonb_build_object('hydration_count',count(*) FILTER(WHERE type='hydration'),
 'movement_count',count(*) FILTER(WHERE type='movement'),'last_hydration_at',private.badge_text(max(occurred_at) FILTER(WHERE type='hydration'),32)) INTO v
 FROM public.wellness_events WHERE owner_id=p_owner AND day_key=day;
 INSERT INTO public.badge_projection VALUES(p_owner::text||':summary',p_owner,'summary',v::text)
 ON CONFLICT(owner_id,kind) DO UPDATE SET payload=excluded.payload;
END $$;
REVOKE ALL ON FUNCTION private.badge_refresh_projection(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.badge_refresh_projection(uuid) TO service_role;
CREATE FUNCTION private.badge_projection_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN PERFORM private.badge_refresh_projection(OLD.owner_id); RETURN OLD; END IF;
 PERFORM private.badge_refresh_projection(NEW.owner_id);
 IF TG_OP='UPDATE' AND OLD.owner_id<>NEW.owner_id THEN PERFORM private.badge_refresh_projection(OLD.owner_id); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.badge_projection_trigger() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER badge_project_pet AFTER INSERT OR UPDATE OR DELETE ON public.pet_sessions FOR EACH ROW EXECUTE FUNCTION private.badge_projection_trigger();
CREATE TRIGGER badge_project_timer AFTER INSERT OR UPDATE OR DELETE ON public.sessions FOR EACH ROW EXECUTE FUNCTION private.badge_projection_trigger();
CREATE TRIGGER badge_project_wellness AFTER INSERT OR UPDATE OR DELETE ON public.wellness_events FOR EACH ROW EXECUTE FUNCTION private.badge_projection_trigger();
DO $$ DECLARE o uuid; BEGIN
 FOR o IN SELECT owner_id FROM public.pet_sessions UNION SELECT owner_id FROM public.sessions UNION SELECT owner_id FROM public.wellness_events LOOP
  PERFORM private.badge_refresh_projection(o);
 END LOOP;
END $$;

-- Separate committed RPC: refused/failed attempts still count. No client IP
-- header is trusted. A hard service-wide budget bounds distributed guessing.
CREATE FUNCTION public.badge_rate_limit(p_scope text,p_subject text,p_limit integer,p_seconds integer DEFAULT 60)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE n integer; b timestamptz;
BEGIN
 IF length(p_scope)>40 OR length(p_subject)>128 OR p_limit<1 OR p_limit>1000 OR p_seconds NOT IN (60,3600) THEN RAISE EXCEPTION 'invalid rate scope'; END IF;
 b:=to_timestamp(floor(extract(epoch FROM clock_timestamp())/p_seconds)*p_seconds);
 DELETE FROM private.badge_rate_windows WHERE bucket<now()-interval '2 hours';
 INSERT INTO private.badge_rate_windows VALUES(p_scope,p_subject,b,1)
 ON CONFLICT(scope,subject_hash,bucket) DO UPDATE SET hits=least(private.badge_rate_windows.hits+1,p_limit+1) RETURNING hits INTO n;
 RETURN n<=p_limit;
END $$;
REVOKE ALL ON FUNCTION public.badge_rate_limit(text,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.badge_rate_limit(text,text,integer,integer) TO service_role;

CREATE FUNCTION private.badge_owner_session(p_owner uuid,p_session uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM auth.sessions WHERE user_id=p_owner AND id=p_session AND (not_after IS NULL OR not_after>now()));
$$;
REVOKE ALL ON FUNCTION private.badge_owner_session(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.badge_owner_session(uuid,uuid) TO service_role;

-- Only the Edge Function's service role may call this RPC. p_owner is taken
-- from Auth /user, never from a JSON owner field. Device actions resolve owner
-- afresh from the hashed credential inside this transaction.
CREATE FUNCTION public.badge_gateway(p_action text,p_owner uuid DEFAULT NULL,p_data jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s private.badge_pairing_sessions; c private.badge_pending_claims; d private.badge_devices;
 cr private.badge_credentials; r private.badge_upload_receipts; e jsonb; prior public.wellness_events;
 v jsonb; cid uuid; oid uuid; stamp text; count_events integer;
BEGIN
 IF p_action IN ('create_pairing','status_pairing','cancel_pairing','approve_claim','list_devices','revoke_device') THEN
  IF p_owner IS NULL OR NOT private.badge_owner_session(p_owner,(p_data->>'auth_session_id')::uuid) THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
  IF p_action='list_devices' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('device_id',id,'name',name,'state',state,'paired_at',paired_at,'last_seen_at',last_seen_at,'revoked_at',revoked_at) ORDER BY paired_at DESC),'[]') INTO v FROM private.badge_devices WHERE owner_id=p_owner;
   RETURN jsonb_build_object('devices',v);
  ELSIF p_action='revoke_device' THEN
   UPDATE private.badge_devices SET state='revoked',revoked_at=coalesce(revoked_at,now()) WHERE id=(p_data->>'device_id')::uuid AND owner_id=p_owner RETURNING * INTO d;
   IF d.id IS NULL THEN RETURN jsonb_build_object('error','not_found'); END IF;
   UPDATE private.badge_credentials SET state='revoked' WHERE device_id=d.id;
   UPDATE private.badge_pending_claims SET state='revoked' WHERE id=d.claim_id;
   UPDATE private.badge_pairing_sessions SET state='revoked' WHERE approved_claim_id=d.claim_id;
   RETURN jsonb_build_object('state','revoked','device_id',d.id);
  ELSIF p_action='create_pairing' THEN
   UPDATE private.badge_pending_claims SET state='rejected' WHERE state='pending' AND session_id IN (SELECT id FROM private.badge_pairing_sessions WHERE owner_id=p_owner AND state='pending');
   UPDATE private.badge_pairing_sessions SET state=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'cancelled' END WHERE owner_id=p_owner AND state='pending';
   -- Expired code collisions must not prevent another owner's allocation.
   UPDATE private.badge_pairing_sessions SET state='expired' WHERE state='pending' AND expires_at<=now();
   INSERT INTO private.badge_pairing_sessions(owner_id,code_hash) VALUES(p_owner,p_data->>'code_hash') RETURNING * INTO s;
   RETURN jsonb_build_object('session_id',s.id,'state',s.state,'expires_at',s.expires_at);
  END IF;
  SELECT * INTO s FROM private.badge_pairing_sessions WHERE id=(p_data->>'session_id')::uuid AND owner_id=p_owner FOR UPDATE;
  IF s.id IS NULL THEN RETURN jsonb_build_object('error','not_found'); END IF;
  IF s.state='pending' AND s.expires_at<=now() THEN
   UPDATE private.badge_pairing_sessions SET state='expired' WHERE id=s.id RETURNING * INTO s;
   UPDATE private.badge_pending_claims SET state='rejected' WHERE session_id=s.id AND state='pending';
  END IF;
  IF p_action='status_pairing' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('claim_id',id,'verification_id',verification_id,'state',state,'device_id',device_id) ORDER BY created_at),'[]') INTO v FROM private.badge_pending_claims WHERE session_id=s.id;
   RETURN jsonb_build_object('session_id',s.id,'state',s.state,'expires_at',s.expires_at,'claims',v);
  ELSIF p_action='cancel_pairing' THEN
   IF s.state='pending' THEN
    UPDATE private.badge_pairing_sessions SET state='cancelled' WHERE id=s.id RETURNING * INTO s;
    UPDATE private.badge_pending_claims SET state='rejected' WHERE session_id=s.id AND state='pending';
   END IF;
   RETURN jsonb_build_object('state',s.state,'session_id',s.id);
  ELSIF p_action='approve_claim' THEN
   SELECT * INTO c FROM private.badge_pending_claims WHERE id=(p_data->>'claim_id')::uuid AND session_id=s.id FOR UPDATE;
   IF c.id IS NULL THEN RETURN jsonb_build_object('error','not_found'); END IF;
   IF s.approved_claim_id=c.id AND s.state IN ('approved','delivered') THEN RETURN jsonb_build_object('state','approved','device_id',c.device_id,'claim_id',c.id); END IF;
   IF s.state<>'pending' OR c.state<>'pending' THEN RETURN jsonb_build_object('error','pairing_unavailable'); END IF;
   IF (SELECT count(*) FROM private.badge_devices WHERE owner_id=p_owner AND state='active')>=5 THEN RETURN jsonb_build_object('error','device_limit'); END IF;
   INSERT INTO private.badge_devices(owner_id,claim_id,name) VALUES(p_owner,c.id,coalesce(p_data->>'name','Badge')) RETURNING * INTO d;
   INSERT INTO private.badge_credentials(credential_hash,device_id) VALUES(c.credential_hash,d.id);
   UPDATE private.badge_pairing_sessions SET state='approved',approved_claim_id=c.id WHERE id=s.id;
   UPDATE private.badge_pending_claims SET state=CASE WHEN id=c.id THEN 'approved' ELSE 'rejected' END,device_id=CASE WHEN id=c.id THEN d.id ELSE NULL END WHERE session_id=s.id;
   PERFORM private.badge_refresh_projection(p_owner);
   RETURN jsonb_build_object('state','approved','device_id',d.id,'claim_id',c.id);
  END IF;
 ELSIF p_action='claim' THEN
  SELECT * INTO c FROM private.badge_pending_claims WHERE pending_hash=p_data->>'pending_hash';
  IF c.id IS NOT NULL THEN
   SELECT * INTO s FROM private.badge_pairing_sessions WHERE id=c.session_id FOR UPDATE;
   SELECT * INTO c FROM private.badge_pending_claims WHERE id=c.id FOR UPDATE;
   IF c.credential_hash<>p_data->>'credential_hash' OR s.code_hash<>p_data->>'code_hash' THEN RETURN jsonb_build_object('error','pairing_unavailable'); END IF;
   IF NOT ((s.state='pending' AND s.expires_at>now()) OR (s.state IN ('approved','delivered') AND c.state='approved' AND c.recovery_until>now())) THEN RETURN jsonb_build_object('error','pairing_unavailable'); END IF;
  ELSE
   SELECT * INTO s FROM private.badge_pairing_sessions WHERE code_hash=p_data->>'code_hash' AND state='pending' FOR UPDATE;
   IF s.id IS NULL OR s.expires_at<=now() OR (SELECT count(*) FROM private.badge_pending_claims WHERE session_id=s.id)>=3 THEN RETURN jsonb_build_object('error','pairing_unavailable'); END IF;
   INSERT INTO private.badge_pending_claims(session_id,pending_hash,credential_hash,verification_id)
    VALUES(s.id,p_data->>'pending_hash',p_data->>'credential_hash',p_data->>'verification_id') RETURNING * INTO c;
  END IF;
  RETURN jsonb_build_object('claim_id',c.id,'verification_id',c.verification_id,'state',c.state,'expires_at',s.expires_at);
 ELSIF p_action='poll' THEN
  SELECT * INTO c FROM private.badge_pending_claims WHERE pending_hash=p_data->>'pending_hash';
  IF c.id IS NULL OR c.recovery_until<=now() THEN RETURN jsonb_build_object('error','pairing_unavailable'); END IF;
  SELECT * INTO s FROM private.badge_pairing_sessions WHERE id=c.session_id;
  RETURN jsonb_build_object('claim_id',c.id,'verification_id',c.verification_id,'state',CASE WHEN c.state='approved' THEN s.state WHEN s.state IN ('expired','cancelled','revoked') THEN s.state WHEN s.expires_at<=now() THEN 'expired' ELSE c.state END,
   'device_id',c.device_id,'owner_id',CASE WHEN c.state='approved' THEN s.owner_id ELSE NULL END);
 ELSIF p_action IN ('ack','token','upload') THEN
  SELECT * INTO cr FROM private.badge_credentials WHERE credential_hash=p_data->>'credential_hash';
  IF cr.device_id IS NULL OR cr.state<>'active' OR cr.expires_at<=now() THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  SELECT owner_id INTO oid FROM private.badge_devices WHERE id=cr.device_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(oid::text,0));
  SELECT * INTO d FROM private.badge_devices WHERE id=cr.device_id FOR UPDATE;
  SELECT * INTO cr FROM private.badge_credentials WHERE credential_hash=p_data->>'credential_hash' FOR UPDATE;
  IF d.state<>'active' OR cr.state<>'active' OR cr.expires_at<=now() THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  UPDATE private.badge_devices SET last_seen_at=now() WHERE id=d.id;
  IF p_action='ack' THEN
   UPDATE private.badge_pairing_sessions SET state='delivered' WHERE approved_claim_id=d.claim_id AND state='approved';
   RETURN jsonb_build_object('state','active','device_id',d.id,'owner_id',d.owner_id);
  ELSIF p_action='token' THEN
   PERFORM private.badge_refresh_projection(d.owner_id);
   RETURN jsonb_build_object('state','active','device_id',d.id,'owner_id',d.owner_id);
  END IF;
  SELECT * INTO r FROM private.badge_upload_receipts WHERE owner_id=d.owner_id AND device_id=d.id AND request_id=(p_data->>'request_id')::uuid;
  IF r.request_id IS NOT NULL THEN
   IF r.payload_hash<>p_data->>'payload_hash' THEN RETURN jsonb_build_object('error','request_conflict'); END IF;
   RETURN r.result;
  END IF;
  count_events:=jsonb_array_length(p_data->'events');
  IF count_events NOT BETWEEN 1 AND 8 OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_data->'events'))<>count_events THEN RETURN jsonb_build_object('error','invalid_events'); END IF;
  -- Validate the entire request before any canonical insertion.
  FOR e IN SELECT value FROM jsonb_array_elements(p_data->'events') LOOP
   cid:=(e->>'id')::uuid;
   IF e->>'type' NOT IN ('hydration','movement') OR e->>'day_key'<>to_char((e->>'occurred_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD')
    OR (e->>'occurred_at')::timestamptz>now()+interval '5 minutes' OR (e->>'occurred_at')::timestamptz<now()-interval '30 days' THEN RETURN jsonb_build_object('error','invalid_events'); END IF;
   SELECT * INTO prior FROM public.wellness_events WHERE id=cid::text;
   IF prior.id IS NOT NULL AND (prior.owner_id<>d.owner_id OR prior.type<>e->>'type' OR prior.day_key<>e->>'day_key' OR prior.occurred_at<>e->>'occurred_at') THEN RETURN jsonb_build_object('error','event_conflict'); END IF;
  END LOOP;
  FOR e IN SELECT value FROM jsonb_array_elements(p_data->'events') LOOP
   INSERT INTO public.wellness_events(id,owner_id,day_key,type,occurred_at) VALUES(e->>'id',d.owner_id,e->>'day_key',e->>'type',e->>'occurred_at') ON CONFLICT(id) DO NOTHING;
   -- A concurrent different-owner UUID collision must roll back this WHOLE batch.
   SELECT * INTO prior FROM public.wellness_events WHERE id=e->>'id';
   IF prior.owner_id<>d.owner_id OR prior.type<>e->>'type' OR prior.day_key<>e->>'day_key' OR prior.occurred_at<>e->>'occurred_at' THEN
    RAISE EXCEPTION 'event id conflict' USING ERRCODE='23505';
   END IF;
  END LOOP;
  v:=jsonb_build_object('state','accepted','request_id',p_data->>'request_id','accepted',count_events);
  INSERT INTO private.badge_upload_receipts(owner_id,device_id,request_id,payload_hash,result) VALUES(d.owner_id,d.id,(p_data->>'request_id')::uuid,p_data->>'payload_hash',v);
  RETURN v;
 END IF;
 RETURN jsonb_build_object('error','invalid_action');
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('error','conflict');
 WHEN invalid_text_representation OR check_violation OR not_null_violation OR datetime_field_overflow THEN RETURN jsonb_build_object('error','invalid_request');
END $$;
REVOKE ALL ON FUNCTION public.badge_gateway(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.badge_gateway(text,uuid,jsonb) TO service_role;
