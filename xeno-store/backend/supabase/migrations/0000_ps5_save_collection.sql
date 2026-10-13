-- XENO STORE · Save Data Store · migration 0000
-- The community save table, its grants, row-level security and the storage
-- policies for the private `ps5-saves` bucket (SPEC §17.22.8).
-- Content as provided by the owner's Garlic mirror; only the labels changed.
-- Run order: 0000 → 0001 → 0002 → 0003 (optional cron) → 0004.

CREATE TABLE public.ps5_save_collection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id text NOT NULL CHECK (title_id ~* '^PPSA\d{5}$'),
  game text NOT NULL CHECK (length(game) BETWEEN 1 AND 120),
  shared_by text NOT NULL CHECK (length(shared_by) BETWEEN 1 AND 60),
  notes text CHECK (notes IS NULL OR length(notes) <= 300),
  file_path text NOT NULL,
  file_name text NOT NULL,
  file_size bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.ps5_save_collection TO anon, authenticated;
GRANT ALL ON public.ps5_save_collection TO service_role;
ALTER TABLE public.ps5_save_collection ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view ps5 saves" ON public.ps5_save_collection FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can add ps5 saves" ON public.ps5_save_collection FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Public read ps5-saves" ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'ps5-saves');
CREATE POLICY "Public upload ps5-saves" ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id = 'ps5-saves');
