-- Verify the existing trigger still fires after removing public EXECUTE.
BEGIN;
CREATE TABLE public.badgegotchi_rls_trigger_test(id INTEGER);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ensure_rls') THEN
        IF NOT (SELECT relrowsecurity FROM pg_class
                WHERE oid = 'public.badgegotchi_rls_trigger_test'::regclass) THEN
            RAISE EXCEPTION 'automatic RLS trigger no longer fires';
        END IF;
        IF has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE')
            OR has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE') THEN
            RAISE EXCEPTION 'event trigger remains executable by clients';
        END IF;
    END IF;
END;
$$;
ROLLBACK;
