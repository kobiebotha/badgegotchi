-- The existing development PowerSync connection uses an explicitly granted
-- replication role. New publication members do not inherit table privileges.
-- Keep this grant limited to the bounded public projection; never private data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync_d946af30634391c2381c8473') THEN
    GRANT SELECT ON public.badge_projection TO powersync_d946af30634391c2381c8473;
  END IF;
END;
$$;
