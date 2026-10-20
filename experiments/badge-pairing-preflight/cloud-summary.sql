-- Only aggregate sizes and schema metadata; no owner IDs or content.
WITH sizes AS (
 SELECT 'sessions' AS table_name, owner_id, pg_column_size(t) AS row_bytes FROM public.sessions t
 UNION ALL SELECT 'wellness_events', owner_id, pg_column_size(t) FROM public.wellness_events t
 UNION ALL SELECT 'pet_sessions', owner_id, pg_column_size(t) FROM public.pet_sessions t
 UNION ALL SELECT 'pet_events', owner_id, pg_column_size(t) FROM public.pet_events t
 UNION ALL SELECT 'daily_activity_summary', owner_id, pg_column_size(t) FROM public.daily_activity_summary t
), per_owner AS (SELECT owner_id, count(*) AS row_count, sum(row_bytes) AS row_bytes FROM sizes GROUP BY owner_id)
SELECT jsonb_build_object(
 'tables', (SELECT jsonb_agg(t) FROM (SELECT table_name, count(*) AS rows, sum(row_bytes) AS logical_row_bytes FROM sizes GROUP BY table_name ORDER BY table_name) t),
 'owners', (SELECT count(*) FROM per_owner),
 'largest_owner_rows', (SELECT max(row_count) FROM per_owner),
 'largest_owner_logical_bytes', (SELECT max(row_bytes) FROM per_owner),
 'publication', (SELECT jsonb_agg(t) FROM (SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname='powersync' ORDER BY schemaname,tablename) t),
 'migrations', (SELECT jsonb_agg(t) FROM (SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version) t)
) AS preflight;
