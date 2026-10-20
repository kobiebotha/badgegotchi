-- Supports a fresh project or the existing development Pomogotchi schema.
-- Preserves all rows; changes pet writes to server-only and adds inference leases.
CREATE TABLE IF NOT EXISTS sessions
(
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT auth.uid(),
    day_key TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('focus', 'break')),
    planned_duration_seconds INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'ended')),
    outcome TEXT CHECK (outcome IN ('completed', 'stopped')),
    started_at TEXT NOT NULL,
    last_resumed_at TEXT NOT NULL,
    paused_at TEXT,
    ended_at TEXT,
    remaining_seconds_at_pause INTEGER
);

CREATE TABLE IF NOT EXISTS wellness_events
(
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT auth.uid(),
    day_key TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('hydration', 'movement')),
    occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_activity_summary
(
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT auth.uid(),
    day_key TEXT NOT NULL,
    ended_focus_count INTEGER NOT NULL DEFAULT 0,
    ended_break_count INTEGER NOT NULL DEFAULT 0,
    hydration_count INTEGER NOT NULL DEFAULT 0,
    movement_count INTEGER NOT NULL DEFAULT 0,
    last_hydration_at TEXT,
    hydration_timer_anchor_at TEXT NOT NULL,
    hydration_reminder_active INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    CONSTRAINT daily_activity_summary_owner_day_key_unique UNIQUE (owner_id, day_key)
);

CREATE INDEX IF NOT EXISTS sessions_owner_day_key_idx ON sessions(owner_id, day_key);
CREATE INDEX IF NOT EXISTS sessions_owner_state_idx ON sessions(owner_id, state);
CREATE INDEX IF NOT EXISTS wellness_events_owner_day_key_idx ON wellness_events(owner_id, day_key);
CREATE INDEX IF NOT EXISTS daily_activity_summary_owner_day_key_idx ON daily_activity_summary(owner_id, day_key);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wellness_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_activity_summary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sessions_select_own ON sessions;
CREATE POLICY sessions_select_own
    ON sessions
    FOR SELECT
    TO authenticated
    USING (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS sessions_insert_own ON sessions;
CREATE POLICY sessions_insert_own
    ON sessions
    FOR INSERT
    TO authenticated
    WITH CHECK (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS sessions_update_own ON sessions;
CREATE POLICY sessions_update_own
    ON sessions
    FOR UPDATE
    TO authenticated
    USING (owner_id = (select auth.uid()))
    WITH CHECK (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS sessions_delete_own ON sessions;
CREATE POLICY sessions_delete_own
    ON sessions
    FOR DELETE
    TO authenticated
    USING (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS wellness_events_select_own ON wellness_events;
CREATE POLICY wellness_events_select_own
    ON wellness_events
    FOR SELECT
    TO authenticated
    USING (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS wellness_events_insert_own ON wellness_events;
CREATE POLICY wellness_events_insert_own
    ON wellness_events
    FOR INSERT
    TO authenticated
    WITH CHECK (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS wellness_events_update_own ON wellness_events;
CREATE POLICY wellness_events_update_own
    ON wellness_events
    FOR UPDATE
    TO authenticated
    USING (owner_id = (select auth.uid()))
    WITH CHECK (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS wellness_events_delete_own ON wellness_events;
CREATE POLICY wellness_events_delete_own
    ON wellness_events
    FOR DELETE
    TO authenticated
    USING (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS daily_activity_summary_select_own ON daily_activity_summary;
CREATE POLICY daily_activity_summary_select_own
    ON daily_activity_summary
    FOR SELECT
    TO authenticated
    USING (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS daily_activity_summary_insert_own ON daily_activity_summary;
CREATE POLICY daily_activity_summary_insert_own
    ON daily_activity_summary
    FOR INSERT
    TO authenticated
    WITH CHECK (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS daily_activity_summary_update_own ON daily_activity_summary;
CREATE POLICY daily_activity_summary_update_own
    ON daily_activity_summary
    FOR UPDATE
    TO authenticated
    USING (owner_id = (select auth.uid()))
    WITH CHECK (owner_id = (select auth.uid()));

DROP POLICY IF EXISTS daily_activity_summary_delete_own ON daily_activity_summary;
CREATE POLICY daily_activity_summary_delete_own
    ON daily_activity_summary
    FOR DELETE
    TO authenticated
    USING (owner_id = (select auth.uid()));

ALTER TABLE sessions REPLICA IDENTITY FULL;
ALTER TABLE wellness_events REPLICA IDENTITY FULL;
ALTER TABLE daily_activity_summary REPLICA IDENTITY FULL;

-- Pet state/results are authoritative on the server. Clients enqueue commands
-- in their local PowerSync database and upload them via pet-ai, never REST CRUD.
CREATE TABLE IF NOT EXISTS public.pet_sessions (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    animal_id TEXT NOT NULL,
    bio_name TEXT NOT NULL,
    bio_summary TEXT NOT NULL,
    latest_speech TEXT NOT NULL DEFAULT '',
    latest_event_id TEXT,
    latest_event_sequence BIGINT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (owner_id)
);

CREATE TABLE IF NOT EXISTS public.pet_events (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Intentionally no FK to pet_sessions: reset replaces the session id but
    -- preserves history and lets old queued commands receive a terminal rejection.
    pet_session_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'start_focus_session', 'pause_focus_session', 'resume_focus_session',
        'complete_focus_session', 'stop_focus_session_early', 'start_break',
        'complete_break', 'stop_break_early', 'pet_pet', 'drink_water', 'move_or_stretch'
    )),
    source_device TEXT NOT NULL CHECK (source_device IN ('macos', 'ios', 'badge')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    reaction_speech TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT,
    event_sequence BIGINT GENERATED ALWAYS AS IDENTITY,
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0
);
-- Incremental additions for the pre-existing pet schema.
ALTER TABLE public.pet_sessions ADD COLUMN IF NOT EXISTS latest_event_sequence BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.pet_sessions ALTER COLUMN latest_speech SET DEFAULT '';
ALTER TABLE public.pet_events ADD COLUMN IF NOT EXISTS event_sequence BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE public.pet_events ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE public.pet_events ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE public.pet_events ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.pet_events ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE public.pet_events DROP CONSTRAINT IF EXISTS pet_events_event_type_check;
ALTER TABLE public.pet_events ADD CONSTRAINT pet_events_event_type_check CHECK (event_type IN (
    'start_focus_session', 'pause_focus_session', 'resume_focus_session',
    'complete_focus_session', 'stop_focus_session_early', 'start_break',
    'complete_break', 'stop_break_early', 'pet_pet', 'drink_water', 'move_or_stretch'
));
ALTER TABLE public.pet_events DROP CONSTRAINT IF EXISTS pet_events_source_device_check;
ALTER TABLE public.pet_events ADD CONSTRAINT pet_events_source_device_check
    CHECK (source_device IN ('macos', 'ios', 'badge'));
DROP POLICY IF EXISTS pet_sessions_insert_own ON public.pet_sessions;
DROP POLICY IF EXISTS pet_sessions_update_own ON public.pet_sessions;
DROP POLICY IF EXISTS pet_sessions_delete_own ON public.pet_sessions;
DROP POLICY IF EXISTS pet_events_insert_own ON public.pet_events;
DROP POLICY IF EXISTS pet_events_update_own ON public.pet_events;
DROP POLICY IF EXISTS pet_events_delete_own ON public.pet_events;
CREATE INDEX IF NOT EXISTS pet_events_owner_session_created_idx
    ON public.pet_events(owner_id, pet_session_id, created_at);
CREATE INDEX IF NOT EXISTS pet_events_owner_sequence_idx ON public.pet_events(owner_id, event_sequence);

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
CREATE TABLE IF NOT EXISTS private.pet_reset_requests (
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, request_id)
);
ALTER TABLE private.pet_reset_requests ENABLE ROW LEVEL SECURITY;
GRANT ALL ON private.pet_reset_requests TO service_role;

ALTER TABLE public.pet_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pet_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pet_sessions_select_own ON public.pet_sessions;
CREATE POLICY pet_sessions_select_own ON public.pet_sessions FOR SELECT
    TO authenticated USING (owner_id = (select auth.uid()));
DROP POLICY IF EXISTS pet_events_select_own ON public.pet_events;
CREATE POLICY pet_events_select_own ON public.pet_events FOR SELECT
    TO authenticated USING (owner_id = (select auth.uid()));
REVOKE ALL ON public.pet_sessions, public.pet_events FROM anon, authenticated;
GRANT SELECT ON public.pet_sessions, public.pet_events TO authenticated;
GRANT ALL ON public.pet_sessions, public.pet_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.pet_events_event_sequence_seq TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.sessions, public.wellness_events, public.daily_activity_summary TO authenticated;
GRANT ALL ON public.sessions, public.wellness_events, public.daily_activity_summary TO service_role;

ALTER TABLE public.pet_sessions REPLICA IDENTITY FULL;
ALTER TABLE public.pet_events REPLICA IDENTITY FULL;
-- Explicit tables keep the private reset ledger out of replication.
DO $$
DECLARE table_name TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync') THEN
        CREATE PUBLICATION powersync;
    END IF;
    IF NOT (SELECT puballtables FROM pg_publication WHERE pubname = 'powersync') THEN
        FOREACH table_name IN ARRAY ARRAY['sessions','wellness_events','daily_activity_summary','pet_sessions','pet_events'] LOOP
            IF NOT EXISTS (SELECT 1 FROM pg_publication_tables p WHERE p.pubname = 'powersync'
                AND p.schemaname = 'public' AND p.tablename = table_name) THEN
                EXECUTE format('ALTER PUBLICATION powersync ADD TABLE public.%I', table_name);
            END IF;
        END LOOP;
    END IF;
END;
$$;

-- Service role only, SECURITY INVOKER: identity comes from verified Auth user.
-- The per-owner advisory lock also serializes concurrent first creation/reset.
CREATE OR REPLACE FUNCTION public.pet_ai_ensure(
    p_owner_id UUID, p_animal_id TEXT, p_animal_name TEXT,
    p_reset BOOLEAN DEFAULT false, p_request_id UUID DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    pet public.pet_sessions;
    stamp TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));
    SELECT * INTO pet FROM public.pet_sessions WHERE owner_id = p_owner_id FOR UPDATE;
    IF p_reset THEN
        IF p_request_id IS NULL THEN RAISE EXCEPTION 'request_id required'; END IF;
        IF EXISTS (SELECT 1 FROM private.pet_reset_requests
            WHERE owner_id = p_owner_id AND request_id = p_request_id) THEN
            RETURN to_jsonb(pet);
        END IF;
        INSERT INTO private.pet_reset_requests(owner_id, request_id) VALUES (p_owner_id, p_request_id);
    ELSIF pet.id IS NOT NULL THEN
        RETURN to_jsonb(pet);
    END IF;

    INSERT INTO public.pet_sessions(id, owner_id, animal_id, bio_name, bio_summary, created_at, updated_at)
        VALUES (gen_random_uuid()::text, p_owner_id, p_animal_id, p_animal_name,
            'A curious, kind ' || p_animal_name || ' who celebrates small steps and healthy breaks.', stamp, stamp)
        ON CONFLICT (owner_id) DO UPDATE SET
            id = EXCLUDED.id, animal_id = EXCLUDED.animal_id, bio_name = EXCLUDED.bio_name,
            bio_summary = EXCLUDED.bio_summary, latest_speech = '', latest_event_id = NULL,
            latest_event_sequence = 0, last_error = NULL, created_at = stamp, updated_at = stamp
        RETURNING * INTO pet;
    RETURN to_jsonb(pet);
END;
$$;

CREATE OR REPLACE FUNCTION public.pet_ai_claim(
    p_owner_id UUID, p_id TEXT, p_pet_session_id TEXT, p_event_type TEXT,
    p_source_device TEXT, p_created_at TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    pet public.pet_sessions;
    event public.pet_events;
    stamp TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
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
    -- Lock ordering matches claim/reset, avoiding event/pet deadlocks.
    PERFORM 1 FROM public.pet_sessions WHERE owner_id = p_owner_id FOR UPDATE;
    SELECT * INTO event FROM public.pet_events WHERE id = p_id AND owner_id = p_owner_id FOR UPDATE;
    IF event.id IS NULL OR event.lease_token IS DISTINCT FROM p_lease_token
        OR event.status <> 'processing' THEN
        RETURN jsonb_build_object('state', 'lease_lost');
    END IF;
    IF p_retry THEN
        UPDATE public.pet_events SET status = 'pending', lease_token = NULL, lease_until = NULL
            WHERE id = p_id;
        RETURN jsonb_build_object('state', 'retry');
    END IF;
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

REVOKE ALL ON FUNCTION public.pet_ai_ensure(UUID, TEXT, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pet_ai_claim(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pet_ai_finish(UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pet_ai_ensure(UUID, TEXT, TEXT, BOOLEAN, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.pet_ai_claim(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.pet_ai_finish(UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN) TO service_role;
