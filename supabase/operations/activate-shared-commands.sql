-- Apply ONLY after the new web bundle and badge package are ready. Existing
-- direct-DML web versions cannot control timers after this activation.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT owner_id FROM public.sessions WHERE state IN ('active','paused') GROUP BY owner_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Resolve ambiguous active account timers before activation'; END IF;
END $$;
REVOKE INSERT,UPDATE,DELETE ON public.sessions,public.wellness_events FROM authenticated;
-- Shared timer commands serialize on the account lock; this also enforces the
-- invariant for privileged callers outside that API.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_live_owner ON public.sessions(owner_id) WHERE state IN ('active','paused');
COMMIT;
