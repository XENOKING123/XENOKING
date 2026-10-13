-- XENO STORE · Save Data Store · migration 0001
-- Cover art path inside the `ps5-saves` bucket (icon0.png pulled from the zip,
-- or a picture the uploader chose). Served through signed URLs.

ALTER TABLE public.ps5_save_collection ADD COLUMN cover_path text;
