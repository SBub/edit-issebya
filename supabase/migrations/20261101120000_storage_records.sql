-- Storage records (app_docs/storage.md): one stored_files row per object a reel uses in R2, with
-- its size and kind, and when it was deleted; and worker_status, where the worker says why it is
-- not claiming jobs. Only the worker (secret key) writes either table, except the source row,
-- which finish_upload records in the same transaction as it queues the job.

create table public.stored_files (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid not null references public.reels (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- `upload` for the raw footage, else the step that wrote it (`convert`, `export`).
  step text not null,
  r2_key text not null,
  bytes bigint not null check (bytes >= 0),
  kind text not null
    constraint stored_files_kind_check
    check (kind in ('source', 'kept', 'rebuildable', 'version', 'export')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (deleted_at is null or deleted_at >= created_at)
);

-- One live row per reel and object; a shared fingerprinted object has one row per reel using it.
create unique index stored_files_live_key_idx on public.stored_files (reel_id, r2_key)
  where deleted_at is null;
create index stored_files_key_idx on public.stored_files (r2_key) where deleted_at is null;
create index stored_files_reel_idx on public.stored_files (reel_id, created_at);

alter table public.stored_files enable row level security;

-- Defence in depth beside RLS: no anon access, and authenticated may only read.
revoke all on public.stored_files from anon, authenticated;
grant select on public.stored_files to authenticated;

create policy "stored_files: owner selects own"
on public.stored_files
for select
to authenticated
using ((select auth.uid()) = owner_id);

create table public.worker_status (
  worker_id text primary key check (length(trim(worker_id)) > 0),
  free_disk_bytes bigint check (free_disk_bytes >= 0),
  waiting_reason text,
  updated_at timestamptz not null default now()
);

create trigger worker_status_set_updated_at
before update on public.worker_status
for each row execute function public.set_updated_at();

alter table public.worker_status enable row level security;

revoke all on public.worker_status from anon, authenticated;
grant select on public.worker_status to authenticated;

-- Holds no reel data: a worker's name, its free disk and why it waits.
create policy "worker_status: signed-in users select"
on public.worker_status
for select
to authenticated
using (true);

-- Records one object for one reel. Idempotent per reel and key: a step that writes the same key
-- again updates the live row; after the row is deleted, the next write creates a new live row.
create function public.record_stored_file(
  p_reel_id uuid,
  p_owner_id uuid,
  p_step text,
  p_r2_key text,
  p_bytes bigint,
  p_kind text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.stored_files (reel_id, owner_id, step, r2_key, bytes, kind)
  values (p_reel_id, p_owner_id, p_step, p_r2_key, p_bytes, p_kind)
  on conflict (reel_id, r2_key) where deleted_at is null
  do update set bytes = excluded.bytes, step = excluded.step, kind = excluded.kind
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.record_stored_file(uuid, uuid, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.record_stored_file(uuid, uuid, text, text, bigint, text)
  to service_role;

-- As before, and the uploaded source is recorded in stored_files in the same transaction.
create or replace function public.finish_upload(p_reel_id uuid, p_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_owner uuid;
  v_key text;
begin
  if p_bytes is null or p_bytes < 1 then
    raise exception 'p_bytes must be at least 1' using errcode = '22023';
  end if;

  update public.reels
  set status = 'uploaded', source_bytes = p_bytes
  where id = p_reel_id
    and owner_id = (select auth.uid())
    and status = 'uploading'
    and source_key is not null
  returning owner_id, source_key into v_owner, v_key;
  if not found then
    raise exception 'no uploading reel of yours with this id' using errcode = 'P0002';
  end if;

  insert into public.stored_files (reel_id, owner_id, step, r2_key, bytes, kind)
  values (p_reel_id, v_owner, 'upload', v_key, p_bytes, 'source');

  insert into public.jobs (reel_id, owner_id, kind)
  values (p_reel_id, (select auth.uid()), 'process')
  returning id into v_job_id;
  return v_job_id;
end;
$$;

revoke execute on function public.finish_upload(uuid, bigint) from public, anon, service_role;
grant execute on function public.finish_upload(uuid, bigint) to authenticated;

-- The studio follows the waiting reason live; stored_files stays out (nothing follows it live).
alter publication supabase_realtime add table public.worker_status;
