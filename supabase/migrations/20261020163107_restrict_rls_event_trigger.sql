-- Existing development projects may have Supabase's ensure_rls event trigger.
-- It is not a client API; removing EXECUTE does not disable DDL trigger firing.
-- Fresh projects that do not have it require no change.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable'
            AND p.pronargs = 0 AND p.prorettype = 'event_trigger'::regtype
    ) THEN
        REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
    END IF;
END;
$$;
