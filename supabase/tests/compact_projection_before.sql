-- Applied by run-account-commands.mjs before the compact projection migration.
-- All fixtures and the first migration application are rolled back afterwards.
DO $$
DECLARE
    o uuid := 'aaaaaaaa-0000-4000-8000-000000000020';
    day text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
    stamp text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    pet jsonb;
BEGIN
    INSERT INTO auth.users VALUES
        (o), ('aaaaaaaa-0000-4000-8000-000000000021'),
        ('aaaaaaaa-0000-4000-8000-000000000022'),
        ('aaaaaaaa-0000-4000-8000-000000000023');
    pet := public.pet_ai_ensure(o, 'cat', 'Cat');
    UPDATE public.pet_sessions SET latest_speech = 'Keep going.' WHERE owner_id = o;
    INSERT INTO public.sessions
        (id, owner_id, day_key, type, planned_duration_seconds, state, outcome,
         started_at, last_resumed_at, paused_at, ended_at, remaining_seconds_at_pause)
    VALUES
        ('compact-focus-completed', o, day, 'focus', 2400, 'ended', 'completed', stamp, stamp, NULL, stamp, 0),
        ('compact-focus-stopped', o, day, 'focus', 2400, 'ended', 'stopped', stamp, stamp, NULL, stamp, 1200),
        ('compact-break-stopped', o, day, 'break', 600, 'ended', 'stopped', stamp, stamp, NULL, stamp, 300),
        ('compact-live', o, day, 'focus', 2400, 'paused', NULL, stamp, stamp, stamp, NULL, 2300);
    INSERT INTO public.wellness_events(id, owner_id, day_key, type, occurred_at) VALUES
        ('compact-water', o, day, 'hydration', stamp),
        ('compact-movement', o, day, 'movement', stamp);
    INSERT INTO public.pet_events(id, owner_id, pet_session_id, event_type, source_device, created_at)
    VALUES ('compact-pet', o, pet->>'id', 'pet_pet', 'badge', stamp);

    -- A stale cached projection with no remaining source rows still needs
    -- rebuilding; otherwise obsolete fields persist indefinitely.
    INSERT INTO public.badge_projection VALUES
        ('aaaaaaaa-0000-4000-8000-000000000021:summary',
         'aaaaaaaa-0000-4000-8000-000000000021', 'summary',
         '{"completed_focus_count":999,"last_hydration_at":"old"}');

    -- Missing cached rows must also be created from each relevant source.
    INSERT INTO public.wellness_events(id, owner_id, day_key, type, occurred_at)
    VALUES ('compact-source-water', 'aaaaaaaa-0000-4000-8000-000000000022', day, 'hydration', stamp);
    INSERT INTO public.pet_events(id, owner_id, pet_session_id, event_type, source_device, created_at)
    VALUES ('compact-source-pet', 'aaaaaaaa-0000-4000-8000-000000000023',
            'old-pet', 'pet_pet', 'badge', stamp);
    DELETE FROM public.badge_projection
    WHERE owner_id IN ('aaaaaaaa-0000-4000-8000-000000000022', 'aaaaaaaa-0000-4000-8000-000000000023');
END;
$$;

CREATE TEMP TABLE compact_projection_before AS
SELECT owner_id, kind, payload::jsonb AS payload
FROM public.badge_projection WHERE owner_id = 'aaaaaaaa-0000-4000-8000-000000000020';
CREATE TEMP TABLE compact_timer_before AS
SELECT private.account_timer('aaaaaaaa-0000-4000-8000-000000000020') AS payload;
