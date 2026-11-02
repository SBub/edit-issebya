-- PostHog sync columns (rule B3.5). PostHog's Postgres source syncs a table
-- incrementally only through a reliable change column, so every table the
-- studio dashboard reads (reels, jobs, steps, versions, exports, stored_files)
-- carries `updated_at timestamptz not null default now()`, moved on every
-- update by the existing public.set_updated_at() trigger function. `reels`
-- already has both (reels_set_updated_at, studio skeleton); this adds them to
-- the other five. Existing rows take now() at migration time from the default.
--
-- `worker_status` is not synced: no metric reads it and its heartbeat would
-- churn the sync, so it is left unchanged.
--
-- Triggers of the same event fire in name order, so on versions, exports and
-- stored_files the existing `*_refuse_update` trigger still runs first:
-- versions and exports stay immutable (their updated_at is the insert time
-- forever), and the one allowed stored_files update, recording deleted_at, now
-- also moves updated_at. stored_files_refuse_update compares named columns
-- only, so setting updated_at never trips it.
--
-- No grant changes: authenticated already selects these tables, and the
-- column-limited insert grants on jobs leave the new column to its default.

alter table public.jobs add column updated_at timestamptz not null default now();
alter table public.steps add column updated_at timestamptz not null default now();
alter table public.versions add column updated_at timestamptz not null default now();
alter table public.exports add column updated_at timestamptz not null default now();
alter table public.stored_files add column updated_at timestamptz not null default now();

create trigger jobs_set_updated_at
before update on public.jobs
for each row execute function public.set_updated_at();

create trigger steps_set_updated_at
before update on public.steps
for each row execute function public.set_updated_at();

create trigger versions_set_updated_at
before update on public.versions
for each row execute function public.set_updated_at();

create trigger exports_set_updated_at
before update on public.exports
for each row execute function public.set_updated_at();

create trigger stored_files_set_updated_at
before update on public.stored_files
for each row execute function public.set_updated_at();
