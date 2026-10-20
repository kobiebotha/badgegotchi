-- Run after the migration. All fixtures and changes are rolled back.
BEGIN;
DO $$
DECLARE
    owner UUID := gen_random_uuid();
    pet JSONB;
    newer_pet JSONB;
    claim1 JSONB;
    claim2 JSONB;
    result JSONB;
    event1 TEXT := gen_random_uuid()::text;
    event2 TEXT := gen_random_uuid()::text;
    reset_request UUID := gen_random_uuid();
    stamp TEXT := '2026-10-20T12:00:00.000Z';
BEGIN
    INSERT INTO auth.users(id) VALUES (owner);
    pet := public.pet_ai_ensure(owner, 'cat', 'Cat');
    IF public.pet_ai_ensure(owner, 'dog', 'Dog')->>'id' <> pet->>'id' THEN
        RAISE EXCEPTION 'ensure must keep existing pet';
    END IF;
    claim1 := public.pet_ai_claim(owner, event1, pet->>'id', 'pause_focus_session', 'badge', stamp);
    IF claim1->>'state' <> 'claimed' THEN RAISE EXCEPTION 'first claim failed'; END IF;
    IF public.pet_ai_claim(owner, event1, pet->>'id', 'pause_focus_session', 'badge', stamp)->>'state' <> 'busy' THEN
        RAISE EXCEPTION 'duplicate in-flight claim must be busy';
    END IF;
    claim2 := public.pet_ai_claim(owner, event2, pet->>'id', 'resume_focus_session', 'macos', stamp);
    result := public.pet_ai_finish(owner, event2, (claim2->'event'->>'lease_token')::uuid, 'Welcome back!');
    IF result->>'state' <> 'completed' THEN RAISE EXCEPTION 'finish failed'; END IF;
    PERFORM public.pet_ai_finish(owner, event1, (claim1->'event'->>'lease_token')::uuid, 'Rest those paws.');
    IF (SELECT latest_speech FROM public.pet_sessions WHERE owner_id = owner) <> 'Welcome back!' THEN
        RAISE EXCEPTION 'older response overwrote newer state';
    END IF;
    IF public.pet_ai_claim(owner, event2, pet->>'id', 'resume_focus_session', 'macos', stamp)->>'state' <> 'completed' THEN
        RAISE EXCEPTION 'completed command repeated inference';
    END IF;
    IF public.pet_ai_claim(owner, event2, pet->>'id', 'pet_pet', 'macos', stamp)->>'state' <> 'rejected' THEN
        RAISE EXCEPTION 'immutable command conflict accepted';
    END IF;
    event1 := gen_random_uuid()::text;
    claim1 := public.pet_ai_claim(owner, event1, pet->>'id', 'pet_pet', 'ios', stamp);
    UPDATE public.pet_events SET lease_until = now() - interval '1 second' WHERE id = event1;
    claim2 := public.pet_ai_claim(owner, event1, pet->>'id', 'pet_pet', 'ios', stamp);
    IF public.pet_ai_finish(owner, event1, (claim1->'event'->>'lease_token')::uuid, 'Stale!')->>'state' <> 'lease_lost' THEN
        RAISE EXCEPTION 'expired claimant overwrote new lease';
    END IF;
    newer_pet := public.pet_ai_ensure(owner, 'dog', 'Dog', true, reset_request);
    PERFORM public.pet_ai_finish(owner, event1, (claim2->'event'->>'lease_token')::uuid, 'Old pet!');
    IF (SELECT latest_speech FROM public.pet_sessions WHERE owner_id = owner) <> '' THEN
        RAISE EXCEPTION 'old session overwrote reset pet';
    END IF;
    IF public.pet_ai_ensure(owner, 'dog', 'Dog', true, reset_request)->>'id' <> newer_pet->>'id' THEN
        RAISE EXCEPTION 'reset retry replaced pet again';
    END IF;
    IF public.pet_ai_claim(owner, gen_random_uuid()::text, pet->>'id', 'pet_pet', 'badge', stamp)->>'state' <> 'rejected' THEN
        RAISE EXCEPTION 'old queued event was not rejected';
    END IF;
    IF has_table_privilege('authenticated', 'public.pet_events', 'INSERT')
        OR has_table_privilege('authenticated', 'public.pet_sessions', 'UPDATE')
        OR has_function_privilege('authenticated', 'public.pet_ai_claim(uuid,text,text,text,text,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'client can bypass server authority';
    END IF;
END;
$$;
ROLLBACK;
