-- XENO STORE · Save Data Store · migration 0004
-- Turns the Garlic mirror table into the XENO Save Data Store (SPEC §17.22.8):
--   * category / game_version / region / tags / downloads / status / source / sha256
--   * the `increment_downloads(id)` RPC used by consoles after a successful install
--   * an index on (title_id, created_at desc) for the per-game "Saves (n)" rail
--   * the `ps5-saves` bucket (created here if missing, 2 GiB per object)
--   * row-level security: public read, public insert limited to moderated rows
--
-- Moderation model (kept deliberately simple):
--   * anyone (consoles with the public anon key) can INSERT, but only rows with
--     status = 'pending' and source = 'xeno' — every community upload waits for
--     review; nothing goes live without the owner (or the xeno-save-submit
--     function with XENO_AUTO_PUBLISH=1) flipping status to 'published'.
--   * the Garlic sync and the submit function run with the service role, which
--     bypasses RLS, so they can insert 'published' rows (source 'garlic' / 'xeno').
--   * consoles only list status = 'published' rows; pending/rejected rows are
--     visible to the anon key (public read) but never shown in the store.
--   * UPDATE / DELETE stay owner-only (service role, SQL editor, dashboard).
-- Idempotent: safe to run twice.

ALTER TABLE public.ps5_save_collection
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS game_version text,
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS downloads integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'xeno',
  ADD COLUMN IF NOT EXISTS sha256 text;

-- Existing Garlic mirror rows are published and come from Garlic.
UPDATE public.ps5_save_collection SET source = 'garlic' WHERE garlic_id IS NOT NULL AND source = 'xeno';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ps5_save_collection_category_check') THEN
    ALTER TABLE public.ps5_save_collection ADD CONSTRAINT ps5_save_collection_category_check
      CHECK (category IS NULL OR category IN ('starter', 'platinum', 'checkpoint', 'modded', 'chapter', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ps5_save_collection_game_version_check') THEN
    ALTER TABLE public.ps5_save_collection ADD CONSTRAINT ps5_save_collection_game_version_check
      CHECK (game_version IS NULL OR game_version ~ '^[0-9]{1,3}(\.[0-9]{1,3}){0,3}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ps5_save_collection_region_check') THEN
    ALTER TABLE public.ps5_save_collection ADD CONSTRAINT ps5_save_collection_region_check
      CHECK (region IS NULL OR region ~ '^[A-Z0-9_-]{1,8}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ps5_save_collection_tags_check') THEN
    ALTER TABLE public.ps5_save_collection ADD CONSTRAINT ps5_save_collection_tags_check
      CHECK (cardinality(tags) <= 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ps5_save_collection_downloads_check') THEN
    ALTER TABLE public.ps5_save_collection ADD CONSTRAINT ps5_save_collection_downloads_check
      CHECK (downloads >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ps5_save_collection_status_check') THEN
    ALTER TABLE public.ps5_save_collection ADD CONSTRAINT ps5_save_collection_status_check
      CHECK (status IN ('pending', 'published', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ps5_save_collection_source_check') THEN
    ALTER TABLE public.ps5_save_collection ADD CONSTRAINT ps5_save_collection_source_check
      CHECK (source IN ('xeno', 'garlic', 'manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ps5_save_collection_sha256_check') THEN
    ALTER TABLE public.ps5_save_collection ADD CONSTRAINT ps5_save_collection_sha256_check
      CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ps5_save_collection_file_size_check') THEN
    ALTER TABLE public.ps5_save_collection ADD CONSTRAINT ps5_save_collection_file_size_check
      CHECK (file_size IS NULL OR (file_size >= 0 AND file_size <= 2147483648));
  END IF;
END $$;

-- Per-game rail + "newest first" listing.
CREATE INDEX IF NOT EXISTS ps5_save_collection_title_created_idx
  ON public.ps5_save_collection (title_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ps5_save_collection_status_created_idx
  ON public.ps5_save_collection (status, created_at DESC);
-- One row per stored object (Garlic rows use 'garlic:<id>', uploads use the bucket path).
CREATE UNIQUE INDEX IF NOT EXISTS ps5_save_collection_file_path_key
  ON public.ps5_save_collection (file_path);

-- Download counter: consoles call this after a verified install/download.
-- SECURITY DEFINER so the anon key can bump the counter without UPDATE rights
-- on the table; only published rows count and it never does anything else.
CREATE OR REPLACE FUNCTION public.increment_downloads(id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ps5_save_collection
     SET downloads = downloads + 1
   WHERE ps5_save_collection.id = increment_downloads.id
     AND status = 'published'
  RETURNING downloads;
$$;
REVOKE ALL ON FUNCTION public.increment_downloads(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.increment_downloads(uuid) TO anon, authenticated, service_role;

-- Row-level security: public read stays; public insert is limited to rows that
-- wait for moderation and come from a XENO STORE console.
DROP POLICY IF EXISTS "Anyone can add ps5 saves" ON public.ps5_save_collection;
CREATE POLICY "Consoles submit pending xeno saves" ON public.ps5_save_collection
  FOR INSERT TO anon, authenticated
  WITH CHECK (status = 'pending' AND source = 'xeno' AND garlic_id IS NULL);
-- To let uploads go live immediately (no review), replace the policy above with:
--   WITH CHECK (status IN ('pending', 'published') AND source = 'xeno' AND garlic_id IS NULL)

-- Storage: the private bucket (signed URLs only) with a 2 GiB object limit.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('ps5-saves', 'ps5-saves', false, 2147483648)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 2147483648;

-- Uploads must live under their title id and be a zip or a png cover:
--   PPSA12345/<uuid>-<name>.zip · PPSA12345/<uuid>-cover.png · PPSA12345/garlic-<id>-cover.png
DROP POLICY IF EXISTS "Public upload ps5-saves" ON storage.objects;
CREATE POLICY "Consoles upload ps5-saves" ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'ps5-saves' AND name ~ '^PPSA[0-9]{5}/[A-Za-z0-9._-]{1,200}\.(zip|png)$');
