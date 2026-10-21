-- Runs after compact_projection_before.sql and the actual additive migration.
DO $$
DECLARE
    o uuid := 'aaaaaaaa-0000-4000-8000-000000000020';
    day text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
    stamp text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    old record;
    row record;
    expected jsonb;
    keys text[];
    expected_keys text[];
    before_rows jsonb;
    after_rows jsonb;
    summary_before jsonb;
    timer_before jsonb;
BEGIN
    -- Backfill changes only unused fields; timer anchors, CAS revisions, pet
    -- identity, event ordering/status and user-visible counters are preserved.
    FOR old IN SELECT * FROM compact_projection_before LOOP
        expected := CASE old.kind
            WHEN 'pet' THEN old.payload - ARRAY['updated_at', 'error']
            WHEN 'timer' THEN old.payload - 'last_command_id'
            ELSE old.payload - ARRAY['completed_focus_count', 'stopped_focus_count',
                                     'completed_break_count', 'stopped_break_count', 'last_hydration_at']
        END;
        IF (SELECT payload::jsonb FROM public.badge_projection WHERE owner_id = old.owner_id AND kind = old.kind)
            IS DISTINCT FROM expected THEN
            RAISE EXCEPTION 'backfill changed consumed % fields', old.kind;
        END IF;
    END LOOP;
    IF private.account_timer(o) IS DISTINCT FROM (SELECT payload FROM compact_timer_before) THEN
        RAISE EXCEPTION 'receipt timer helper changed';
    END IF;
    FOR row IN SELECT kind, payload::jsonb AS payload FROM public.badge_projection LOOP
        SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(row.payload) AS key;
        expected_keys := CASE row.kind
            WHEN 'pet' THEN ARRAY['animal_id', 'id', 'latest_event_id', 'name', 'speech', 'status']
            WHEN 'timer' THEN ARRAY['id', 'last_resumed_at', 'paused_at', 'planned_duration_seconds',
                                   'remaining_seconds_at_pause', 'revision', 'started_at', 'state', 'type']
            ELSE ARRAY['day_key', 'ended_break_count', 'ended_focus_count', 'hydration_count', 'movement_count', 'pet_count']
        END;
        IF keys IS DISTINCT FROM expected_keys THEN
            RAISE EXCEPTION 'unexpected % payload keys: %', row.kind, keys;
        END IF;
    END LOOP;
    IF (SELECT count(*) FROM public.badge_projection WHERE owner_id = o) <> 3
        OR EXISTS (SELECT 1 FROM public.badge_projection WHERE octet_length(payload) > 1536) THEN
        RAISE EXCEPTION 'projection storage contract changed';
    END IF;
    IF (SELECT payload::jsonb->>'hydration_count' FROM public.badge_projection
        WHERE owner_id = 'aaaaaaaa-0000-4000-8000-000000000021' AND kind = 'summary') IS DISTINCT FROM '0'
        OR (SELECT count(*) FROM public.badge_projection WHERE owner_id = 'aaaaaaaa-0000-4000-8000-000000000021') <> 2
        OR (SELECT payload::jsonb->>'hydration_count' FROM public.badge_projection
            WHERE owner_id = 'aaaaaaaa-0000-4000-8000-000000000022' AND kind = 'summary') IS DISTINCT FROM '1'
        OR (SELECT payload::jsonb->>'pet_count' FROM public.badge_projection
            WHERE owner_id = 'aaaaaaaa-0000-4000-8000-000000000023' AND kind = 'summary') IS DISTINCT FROM '1' THEN
        RAISE EXCEPTION 'backfill missed cached-only or source-only owners';
    END IF;

    -- ctid changes even when an UPDATE shares the current transaction's xmin,
    -- so this detects unnecessary rewrites rather than only equal final values.
    SELECT jsonb_object_agg(kind, jsonb_build_object('ctid', ctid::text, 'payload', payload))
    INTO before_rows FROM public.badge_projection WHERE owner_id = o;
    UPDATE public.pet_sessions SET created_at = stamp,
        updated_at = to_char((now() + interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHERE owner_id = o;
    UPDATE public.pet_events SET claimed_at = stamp, completed_at = stamp,
        error_message = 'Internal audit detail' WHERE id = 'compact-pet';
    PERFORM private.badge_refresh_projection(o);
    SELECT jsonb_object_agg(kind, jsonb_build_object('ctid', ctid::text, 'payload', payload))
    INTO after_rows FROM public.badge_projection WHERE owner_id = o;
    IF before_rows IS DISTINCT FROM after_rows THEN
        RAISE EXCEPTION 'audit-only updates rewrote projection';
    END IF;

    UPDATE public.pet_events SET status = 'processing' WHERE id = 'compact-pet';
    IF (SELECT payload::jsonb->>'status' FROM public.badge_projection WHERE owner_id = o AND kind = 'pet')
        IS DISTINCT FROM 'processing' THEN
        RAISE EXCEPTION 'AI status no longer projected';
    END IF;
    UPDATE public.pet_sessions SET latest_speech = 'A new reply.' WHERE owner_id = o;
    IF (SELECT payload::jsonb->>'speech' FROM public.badge_projection WHERE owner_id = o AND kind = 'pet')
        IS DISTINCT FROM 'A new reply.' THEN
        RAISE EXCEPTION 'pet speech no longer projected';
    END IF;

    SELECT payload::jsonb INTO timer_before FROM public.badge_projection WHERE owner_id = o AND kind = 'timer';
    UPDATE public.sessions SET state = 'active', last_resumed_at = stamp, paused_at = NULL WHERE id = 'compact-live';
    IF (SELECT payload::jsonb FROM public.badge_projection WHERE owner_id = o AND kind = 'timer')
        IS DISTINCT FROM (private.account_timer(o) - 'last_command_id')
        OR (private.account_timer(o)->>'revision')::bigint <> (timer_before->>'revision')::bigint + 1
        OR private.account_timer(o)->>'state' <> 'active' THEN
        RAISE EXCEPTION 'timer state/anchors/revision changed';
    END IF;
    SELECT payload::jsonb INTO summary_before FROM public.badge_projection WHERE owner_id = o AND kind = 'summary';
    IF summary_before->>'ended_focus_count' <> '2' OR summary_before->>'ended_break_count' <> '1'
        OR summary_before->>'hydration_count' <> '1' OR summary_before->>'movement_count' <> '1'
        OR summary_before->>'pet_count' <> '1' THEN
        RAISE EXCEPTION 'canonical counters changed: %', summary_before;
    END IF;
    INSERT INTO public.wellness_events(id, owner_id, day_key, type, occurred_at)
    VALUES ('compact-water-next', o, day, 'hydration', stamp);
    IF (SELECT payload::jsonb FROM public.badge_projection WHERE owner_id = o AND kind = 'summary')
        IS DISTINCT FROM jsonb_set(summary_before, '{hydration_count}', '2') THEN
        RAISE EXCEPTION 'new wellness count no longer projected';
    END IF;
    IF has_function_privilege('authenticated', 'private.badge_refresh_projection(uuid)', 'EXECUTE')
        OR has_function_privilege('anon', 'private.badge_refresh_projection(uuid)', 'EXECUTE')
        OR NOT has_function_privilege('service_role', 'private.badge_refresh_projection(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'projection refresh privileges changed';
    END IF;
END;
$$;
