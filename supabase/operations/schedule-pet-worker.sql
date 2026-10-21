BEGIN;
-- Operator setup: create Vault secrets named badgegotchi_pet_worker_url and
-- badgegotchi_pet_worker_secret. The latter must match PET_WORKER_SECRET on the
-- dedicated function. Supply their values out of band, never in this file.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
DO $$ BEGIN
 IF (SELECT count(*) FROM vault.decrypted_secrets WHERE name IN ('badgegotchi_pet_worker_url','badgegotchi_pet_worker_secret'))<>2 THEN
  RAISE EXCEPTION 'Configure the two named pet worker Vault secrets first';
 END IF;
END $$;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='badgegotchi-pet-worker';
SELECT cron.schedule('badgegotchi-pet-worker','* * * * *',$job$
 SELECT net.http_post(
  url:=(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='badgegotchi_pet_worker_url'),
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='badgegotchi_pet_worker_secret')),
  body:='{}'::jsonb,timeout_milliseconds:=45000
 );
$job$);

-- pg_net queues the HTTP request transactionally and dispatches after commit.
-- Failure to schedule a prompt wake never rolls back domain acceptance: cron
-- independently scans the persisted pending/expired-lease work every minute.
CREATE OR REPLACE FUNCTION private.pet_worker_wake() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target text; worker_secret text;
BEGIN
 SELECT decrypted_secret INTO target FROM vault.decrypted_secrets WHERE name='badgegotchi_pet_worker_url';
 SELECT decrypted_secret INTO worker_secret FROM vault.decrypted_secrets WHERE name='badgegotchi_pet_worker_secret';
 IF target IS NOT NULL AND length(worker_secret)>=32 THEN
  PERFORM net.http_post(url:=target,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||worker_secret),body:='{}'::jsonb,timeout_milliseconds:=45000);
 END IF;
 RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.pet_worker_wake() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS pet_worker_wake ON public.pet_events;
CREATE TRIGGER pet_worker_wake AFTER INSERT ON public.pet_events FOR EACH ROW EXECUTE FUNCTION private.pet_worker_wake();

COMMIT;
