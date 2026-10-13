-- XENO STORE · Save Data Store · migration 0002
-- Rows mirrored from garlicsaves.com carry the Garlic save id so the sync
-- skips saves it already knows (file_path = 'garlic:<id>', zip fetched on demand).

ALTER TABLE public.ps5_save_collection ADD COLUMN IF NOT EXISTS garlic_id integer UNIQUE;
GRANT ALL ON public.ps5_save_collection TO service_role;
