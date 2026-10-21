-- Keep only fields consumed by the badge or the shared browser projection.
-- Source audit/history columns and immutable command receipts are unchanged.
CREATE OR REPLACE FUNCTION private.badge_refresh_projection(p_owner uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    day text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
    v jsonb;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_owner::text, 0));
    SELECT jsonb_build_object(
        'id', private.badge_text(p.id, 64),
        'animal_id', private.badge_text(p.animal_id, 32),
        'name', private.badge_text(p.bio_name, 40),
        'speech', private.badge_text(p.latest_speech, 160),
        'latest_event_id', private.badge_text(e.id, 64),
        'status', e.status
    ) INTO v
    FROM public.pet_sessions p
    LEFT JOIN LATERAL (
        SELECT id, status FROM public.pet_events
        WHERE owner_id = p_owner AND pet_session_id = p.id
        ORDER BY event_sequence DESC LIMIT 1
    ) e ON true
    WHERE p.owner_id = p_owner;
    IF v IS NULL THEN
        DELETE FROM public.badge_projection WHERE owner_id = p_owner AND kind = 'pet';
    ELSE
        WHILE octet_length(v::text) > 1536 AND length(coalesce(v->>'speech', '')) > 0 LOOP
            v := jsonb_set(v, '{speech}', to_jsonb(left(v->>'speech', length(v->>'speech') - 1)));
        END LOOP;
        INSERT INTO public.badge_projection VALUES (p_owner::text || ':pet', p_owner, 'pet', v::text)
        ON CONFLICT (owner_id, kind) DO UPDATE SET payload = excluded.payload
        WHERE badge_projection.payload IS DISTINCT FROM excluded.payload;
    END IF;

    -- Receipts retain the complete helper shape. Clients reconcile by revision;
    -- last_command_id is not needed in the row stored and synced to the badge.
    v := private.account_timer(p_owner) - 'last_command_id';
    INSERT INTO public.badge_projection VALUES (p_owner::text || ':timer', p_owner, 'timer', v::text)
    ON CONFLICT (owner_id, kind) DO UPDATE SET payload = excluded.payload
    WHERE badge_projection.payload IS DISTINCT FROM excluded.payload;

    SELECT jsonb_build_object(
        'day_key', day,
        'ended_focus_count', count(*) FILTER (WHERE type = 'focus' AND state = 'ended'),
        'ended_break_count', count(*) FILTER (WHERE type = 'break' AND state = 'ended')
    ) INTO v
    FROM public.sessions WHERE owner_id = p_owner AND day_key = day;
    SELECT v || jsonb_build_object(
        'hydration_count', count(*) FILTER (WHERE type = 'hydration'),
        'movement_count', count(*) FILTER (WHERE type = 'movement')
    ) INTO v
    FROM public.wellness_events WHERE owner_id = p_owner AND day_key = day;
    SELECT v || jsonb_build_object('pet_count', count(*)) INTO v
    FROM public.pet_events
    WHERE owner_id = p_owner AND event_type = 'pet_pet' AND left(created_at, 10) = day;
    INSERT INTO public.badge_projection VALUES (p_owner::text || ':summary', p_owner, 'summary', v::text)
    ON CONFLICT (owner_id, kind) DO UPDATE SET payload = excluded.payload
    WHERE badge_projection.payload IS DISTINCT FROM excluded.payload;
END;
$$;

-- Refresh existing rows now, including owners with only a cached projection or
-- old pet events. The unchanged row IDs preserve existing stream checkpoints.
DO $$
DECLARE o uuid;
BEGIN
    FOR o IN
        SELECT owner_id FROM public.badge_projection
        UNION SELECT owner_id FROM public.pet_sessions
        UNION SELECT owner_id FROM public.sessions
        UNION SELECT owner_id FROM public.wellness_events
        UNION SELECT owner_id FROM public.pet_events
    LOOP
        PERFORM private.badge_refresh_projection(o);
    END LOOP;
END;
$$;
