-- XENO STORE · Save Data Store · migration 0003 (optional)
-- Every 6 hours: pull new PS5 saves from garlicsaves.com into
-- public.ps5_save_collection and fill covers for a few rows per run.
-- Requires the pg_cron + pg_net extensions (Database → Extensions on hosted
-- projects). Before running:
--   * replace YOUR-PROJECT-REF with your project ref,
--   * replace YOUR-ANON-KEY with the project's public anon key,
--   * replace YOUR-SYNC-TOKEN with the value of the XENO_SYNC_TOKEN secret
--     (or delete the x-xeno-sync-token header if you did not set that secret).
-- Skip this file entirely if you do not want the Garlic mirror.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'garlic-savedb-sync',
  '0 */6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/garlic-savedb',
    headers := '{"Content-Type":"application/json","apikey":"YOUR-ANON-KEY","Authorization":"Bearer YOUR-ANON-KEY","x-xeno-sync-token":"YOUR-SYNC-TOKEN"}'::jsonb,
    body := '{"action":"sync","covers":6}'::jsonb,
    timeout_milliseconds := 140000
  );
  $$
);
