-- XenoSaves Archive — initial schema.
-- Independent database: never point this at any existing XenoSaves/Supabase project.

create extension if not exists pg_trgm;

do $$ begin
  create type record_status as enum (
    'DISCOVERED',          -- seen at a source, not yet evaluated
    'PERMISSION_PENDING',  -- downloadable, but redistribution permission not established
    'QUEUED',              -- permission cleared, waiting for a download slot
    'DOWNLOADING',         -- leased by a worker, bytes in flight
    'VERIFYING',           -- downloaded, hashing / archive-safety / malware checks running
    'STORED',              -- a real file exists in object storage (blob_sha256 set)
    'FAILED',              -- permanent failure (dead link, retries exhausted, invalid file)
    'RESTRICTED',          -- access-controlled (login/captcha/password/quota/paywall) or external-only — never bypassed
    'QUARANTINED',         -- downloaded but flagged unsafe; isolated and never served
    'REMOVED'              -- taken down by the owner
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type source_policy as enum (
    'MIRROR_ALLOWED',       -- licence/terms explicitly permit redistribution (evidence recorded)
    'PERMISSION_REQUIRED',  -- may be catalogued; files only fetched after permission is recorded
    'EXTERNAL_ONLY',        -- metadata + link only, never downloaded
    'BLOCKED'               -- terms forbid automated access; connector must not run
  );
exception when duplicate_object then null; end $$;

create table if not exists sources (
  id                          text primary key,
  name                        text not null,
  kind                        text not null,                -- connector type
  homepage                    text,
  config                      jsonb not null default '{}'::jsonb,
  policy                      source_policy not null,
  license                     text,
  permission_evidence         text,                         -- URL / note proving permission
  enabled                     boolean not null default false,
  paused                      boolean not null default false,
  discovery_interval_minutes  integer not null default 1440,
  last_discovery_at           timestamptz,
  last_discovery_status       text,
  last_discovery_error        text,
  last_discovery_stats        jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- One row per unique file (content-addressed by SHA-256).
create table if not exists blobs (
  sha256               char(64) primary key,
  size_bytes           bigint not null check (size_bytes >= 0),
  storage_key          text not null unique,
  archive_format       text,
  entry_count          integer,
  uncompressed_bytes   bigint,
  content_fingerprint  char(64),         -- hash of sorted (path,size,crc) — finds re-packed duplicates
  manifest             jsonb,            -- archive listing (capped)
  sfo                  jsonb,            -- parsed PARAM.SFO fields, if present
  checks               jsonb not null,   -- integrity / archive-safety / malware scan results
  quarantined          boolean not null default false,
  deleted_at           timestamptz,
  created_at           timestamptz not null default now()
);
create index if not exists blobs_fingerprint_idx on blobs (content_fingerprint) where content_fingerprint is not null;

create table if not exists save_records (
  id                  bigserial primary key,
  source_id           text not null references sources(id),
  source_item_key     text not null,          -- stable id of the item within its source
  source_page_url     text,                   -- original post / listing page
  download_url        text,                   -- original file link (as published)
  file_host           text,                   -- resolver id: github-raw, mediafire, mega, gdrive, ...
  platform            text check (platform in ('PS4','PS5')),
  game_title          text,
  title_id            text,
  region              text,
  region_source       text,
  category            text,
  category_source     text,                   -- 'source' | 'keyword-heuristic' | 'owner'
  description         text,                   -- verbatim from source
  original_author     text,                   -- creator, only when the source states it
  uploaded_by         text,                   -- uploader / committer as recorded by the source
  uploaded_by_source  text,
  original_filename   text,
  file_format         text,
  expected_size       bigint,
  expected_hash       text,                   -- e.g. 'git-blob-sha1:<hex>' published by the source
  status              record_status not null default 'DISCOVERED',
  status_reason       text,
  redistribution      text not null default 'pending' check (redistribution in ('granted','pending','denied')),
  permission_basis    text,                   -- why redistribution is granted (licence + evidence)
  verified            boolean not null default false,
  blob_sha256         char(64) references blobs(sha256),
  attempts            integer not null default 0,
  max_attempts        integer not null default 6,
  next_attempt_at     timestamptz,
  last_error          text,
  lease_owner         text,
  lease_expires_at    timestamptz,
  bytes_downloaded    bigint not null default 0,
  bytes_total         bigint,
  raw                 jsonb not null default '{}'::jsonb,
  discovered_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),   -- last discovery run that still listed it
  downloaded_at       timestamptz,
  updated_at          timestamptz not null default now(),
  unique (source_id, source_item_key)
);
create index if not exists save_records_queue_idx on save_records (status, next_attempt_at);
create index if not exists save_records_title_idx on save_records (title_id);
create index if not exists save_records_blob_idx on save_records (blob_sha256);
create index if not exists save_records_platform_idx on save_records (platform, category);
create index if not exists save_records_game_trgm on save_records using gin (game_title gin_trgm_ops);
create index if not exists save_records_desc_trgm on save_records using gin (description gin_trgm_ops);
create index if not exists save_records_dl_url_idx on save_records (download_url);

-- Download / processing log per record.
create table if not exists job_events (
  id          bigserial primary key,
  record_id   bigint references save_records(id) on delete cascade,
  source_id   text,
  at          timestamptz not null default now(),
  level       text not null default 'info',
  event       text not null,
  message     text,
  details     jsonb
);
create index if not exists job_events_record_idx on job_events (record_id, at desc);
create index if not exists job_events_at_idx on job_events (at desc);

create table if not exists workers (
  id          text primary key,
  started_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  info        jsonb not null default '{}'::jsonb
);

create table if not exists settings (
  key    text primary key,
  value  jsonb not null,
  updated_at timestamptz not null default now()
);
insert into settings (key, value) values
  ('collection_state', '"running"'::jsonb),           -- running | paused | stopped
  ('global_concurrency', '4'::jsonb),
  ('storage_soft_limit_bytes', '483183820800'::jsonb),  -- 450 GiB warning
  ('storage_hard_limit_bytes', '536870912000'::jsonb)   -- 500 GiB: stop new downloads
on conflict (key) do nothing;

create table if not exists api_keys (
  id          bigserial primary key,
  name        text not null,
  key_hash    char(64) not null unique,     -- sha256 of the key; the key itself is never stored
  scopes      text[] not null default array['catalog','download'],
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create table if not exists downloads (
  id          bigserial primary key,
  record_id   bigint not null references save_records(id) on delete cascade,
  api_key_id  bigint references api_keys(id),
  ip_hash     char(64),
  at          timestamptz not null default now()
);
create index if not exists downloads_record_idx on downloads (record_id);

create table if not exists audit_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  actor    text not null,
  action   text not null,
  target   text,
  details  jsonb
);

create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
