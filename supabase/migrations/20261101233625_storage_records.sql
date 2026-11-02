-- Storage records, slimming and the disk guard (slice 14). Every stored object
-- is a `stored_files` row: its reel, the step that made it, its size and kind,
-- and when it was deleted. One undeleted row per reel and key, so an output
-- two reels share (the same fingerprint) has a row per reel needing it, and
-- "who still needs this object" is a query. The worker writes rows with the
-- secret key; the studio's only write is the source row inside finish_upload.
-- Two functions select what may be deleted and record the deletion in the
-- same statement: rebuildable outputs seven days after the last export of
-- every reel holding them, and expired exports. `worker_status` holds why a
-- worker is not claiming (free disk below its minimum); signed-in users read
-- it live.

create table public.stored_files (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid not null references public.reels (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  step text not null check (step ~ '^[a-z_]{1,40}$'),
  r2_key text not null check (length(r2_key) between 1 and 512),
  bytes bigint not null check (bytes >= 0),
  kind text not null check (kind in ('source', 'kept', 'rebuildable', 'version', 'export')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (deleted_at is null or deleted_at >= created_at)
);

create unique index stored_files_live_idx on public.stored_files (reel_id, r2_key)
  where deleted_at is null;
create index stored_files_live_key_idx on public.stored_files (r2_key)
  where deleted_at is null;
create index stored_files_reel_idx on public.stored_files (reel_id);

-- The owner is never trusted from the caller.
create function public.stored_files_set_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.owner_id := (select r.owner_id from public.reels r where r.id = new.reel_id);
  return new;
end;
$$;

revoke execute on function public.stored_files_set_owner() from public, anon, authenticated;

create trigger stored_files_before_insert
before insert on public.stored_files
for each row execute function public.stored_files_set_owner();

-- A row only ever records its deletion, once, not even the service role
-- changes anything else. Deletes stay possible through the reel's cascade.
create function public.stored_files_refuse_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is null
    and new.deleted_at is not null
    and new.id = old.id
    and new.reel_id = old.reel_id
    and new.owner_id = old.owner_id
    and new.step = old.step
    and new.r2_key = old.r2_key
    and new.bytes = old.bytes
    and new.kind = old.kind
    and new.created_at = old.created_at
  then
    return new;
  end if;
  raise exception 'stored_files rows only record a deletion' using errcode = '55000';
end;
$$;

create trigger stored_files_refuse_update
before update on public.stored_files
for each row execute function public.stored_files_refuse_update();

alter table public.stored_files enable row level security;

-- Defence in depth beside RLS: no anon access; authenticated may only read.
revoke all on public.stored_files from anon;
revoke all on public.stored_files from authenticated;
grant select on public.stored_files to authenticated;

create policy "stored_files: owner selects own"
on public.stored_files
for select
to authenticated
using ((select auth.uid()) = owner_id);

-- Records that a reel needs an object. A second call for the same reel and key
-- adds nothing while the first row is undeleted (a retried job).
create function public.record_stored_file(
  p_reel_id uuid,
  p_r2_key text,
  p_step text,
  p_kind text,
  p_bytes bigint
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.stored_files (reel_id, step, r2_key, bytes, kind)
  values (p_reel_id, p_step, p_r2_key, p_bytes, p_kind)
  on conflict (reel_id, r2_key) where deleted_at is null do nothing;
$$;

revoke execute on function public.record_stored_file(uuid, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.record_stored_file(uuid, text, text, text, bigint)
  to service_role;

-- Marks and returns the rebuildable keys under the prefix that no reel needs
-- any more: every undeleted row of the key (any kind, any reel) belongs to a
-- reel whose last export is older than seven days. A reel never exported, or
-- exported within seven days, keeps the key for everyone. Selection and
-- marking are one statement.
create function public.slim_rebuildable_files(p_now timestamptz, p_prefix text)
returns table (r2_key text, bytes bigint)
language sql
security definer
set search_path = ''
as $$
  with last_export as (
    select e.reel_id, max(e.created_at) as at
    from public.exports e
    group by e.reel_id
  ),
  candidates as (
    select f.r2_key
    from public.stored_files f
    left join last_export le on le.reel_id = f.reel_id
    where f.deleted_at is null
      and starts_with(f.r2_key, p_prefix)
    group by f.r2_key
    having bool_and(f.kind = 'rebuildable')
      and bool_and(le.at is not null and le.at < p_now - interval '7 days')
  ),
  marked as (
    update public.stored_files f
    set deleted_at = greatest(p_now, f.created_at)
    from candidates c
    where f.deleted_at is null
      and f.r2_key = c.r2_key
    returning f.r2_key, f.bytes
  )
  select m.r2_key, max(m.bytes)
  from marked m
  group by m.r2_key
  order by m.r2_key;
$$;

revoke execute on function public.slim_rebuildable_files(timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.slim_rebuildable_files(timestamptz, text) to service_role;

-- Marks and returns the export files under the prefix whose export expired.
create function public.expire_export_files(p_now timestamptz, p_prefix text)
returns table (r2_key text, bytes bigint)
language sql
security definer
set search_path = ''
as $$
  with marked as (
    update public.stored_files f
    set deleted_at = greatest(p_now, f.created_at)
    from public.exports e
    where f.deleted_at is null
      and f.kind = 'export'
      and starts_with(f.r2_key, p_prefix)
      and e.r2_key = f.r2_key
      and e.expires_at < p_now
    returning f.r2_key, f.bytes
  )
  select m.r2_key, max(m.bytes)
  from marked m
  group by m.r2_key
  order by m.r2_key;
$$;

revoke execute on function public.expire_export_files(timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.expire_export_files(timestamptz, text) to service_role;

-- finish_upload as in 20261101212954_multipart_upload.sql, plus the source row:
-- the uploading branch records the raw footage with the size storage reported,
-- in the same transaction. A repeated call records nothing more.
create or replace function public.finish_upload(p_reel_id uuid, p_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_source_key text;
  v_job_id uuid;
begin
  if p_bytes is null or p_bytes < 1 then
    raise exception 'p_bytes must be at least 1' using errcode = '22023';
  end if;

  select status, source_key into v_status, v_source_key
  from public.reels
  where id = p_reel_id
    and owner_id = (select auth.uid())
    and source_key is not null
  for update;
  if not found or v_status = 'failed' then
    raise exception 'no uploading reel of yours with this id' using errcode = 'P0002';
  end if;

  if v_status = 'uploading' then
    update public.reels
    set status = 'uploaded', source_bytes = p_bytes
    where id = p_reel_id;

    insert into public.stored_files (reel_id, owner_id, step, r2_key, bytes, kind)
    values (p_reel_id, (select auth.uid()), 'upload', v_source_key, p_bytes, 'source')
    on conflict (reel_id, r2_key) where deleted_at is null do nothing;

    insert into public.jobs (reel_id, owner_id, kind)
    values (p_reel_id, (select auth.uid()), 'process')
    returning id into v_job_id;
    return v_job_id;
  end if;

  -- Already finished (any later pipeline status): the reel's process job.
  select id into v_job_id
  from public.jobs
  where reel_id = p_reel_id and kind = 'process'
  order by created_at, id
  limit 1;
  if v_job_id is null then
    raise exception 'no process job for this reel' using errcode = 'P0002';
  end if;
  return v_job_id;
end;
$$;

revoke execute on function public.finish_upload(uuid, bigint) from public, anon, service_role;
grant execute on function public.finish_upload(uuid, bigint) to authenticated;

-- One row per worker: its free disk and, while it is not claiming, why. No
-- reel data, so every signed-in user reads every row; only the service role
-- writes.
create table public.worker_status (
  worker_id text primary key check (length(worker_id) between 1 and 200),
  free_disk_bytes bigint not null check (free_disk_bytes >= 0),
  waiting_reason text
    check (waiting_reason is null or length(waiting_reason) between 1 and 200),
  updated_at timestamptz not null default now()
);

alter table public.worker_status enable row level security;

revoke all on public.worker_status from anon;
revoke all on public.worker_status from authenticated;
grant select on public.worker_status to authenticated;

create policy "worker_status: signed-in users read"
on public.worker_status
for select
to authenticated
using (true);

alter publication supabase_realtime add table public.worker_status;
