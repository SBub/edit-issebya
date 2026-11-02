-- Photo library (app_docs/photo-library.md). The owner uploads a photo once,
-- straight to storage, and every reel may use it later. A photo row starts
-- `uploading` (a column-limited insert by its owner), finish_photo_upload
-- moves it to `describing` with the size storage reported, records the
-- original's stored-file row and queues one `describe_photo` job; the worker
-- makes the thumbnail and the large copy, asks the AI for one sentence and 3
-- to 8 lowercase tags, and writes the row `ready` (or `failed`). Owners never
-- write a photo's status, description or tags; they delete their own photo
-- through delete_photo, its jobs, steps and stored-file rows going with it.
--
-- jobs, steps and stored_files now name either a reel or a photo, never both:
-- reel_id becomes nullable beside a new photo_id. claim_job keeps one job per
-- reel at a time and adds one job per photo. Photo files are never slimmed:
-- nothing would rebuild them.

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  r2_key text not null unique check (length(r2_key) between 1 and 512),
  upload_id text
    constraint photos_upload_id_check check (
      upload_id is null
      or (upload_id ~ '^[A-Za-z0-9._~-]+$' and length(upload_id) <= 1024)
    ),
  file_name text not null check (char_length(file_name) between 1 and 255),
  content_type text not null check (
    content_type in ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp')
  ),
  bytes bigint check (bytes is null or bytes between 1 and 26214400),
  width int check (width is null or width > 0),
  height int check (height is null or height > 0),
  status text not null default 'uploading'
    constraint photos_status_check check (status in ('uploading', 'describing', 'ready', 'failed')),
  description text check (description is null or char_length(description) between 1 and 200),
  tags text[] not null default '{}' check (
    cardinality(tags) <= 8
    and lower(array_to_string(tags, ' ')) = array_to_string(tags, ' ')
  ),
  model text,
  prompt_version text,
  thumbnail_key text check (thumbnail_key is null or length(thumbnail_key) between 1 and 512),
  large_key text check (large_key is null or length(large_key) between 1 and 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A ready photo carries everything the library and the AI read.
  constraint photos_ready_check check (
    status <> 'ready'
    or (
      description is not null
      and width is not null
      and height is not null
      and thumbnail_key is not null
      and large_key is not null
      and cardinality(tags) between 3 and 8
    )
  )
);

create unique index photos_upload_id_idx on public.photos (upload_id)
  where upload_id is not null;
create index photos_owner_idx on public.photos (owner_id, created_at desc);

create trigger photos_set_updated_at
before update on public.photos
for each row execute function public.set_updated_at();

alter table public.photos enable row level security;

-- Defence in depth beside RLS: no anon access; authenticated reads and may
-- insert only the columns the insert policy checks. status, owner_id, bytes
-- and everything the worker writes come from their defaults.
revoke all on public.photos from anon, authenticated;
grant select on public.photos to authenticated;
grant insert (id, file_name, r2_key, content_type, upload_id) on public.photos to authenticated;
grant select, insert, update, delete on public.photos to service_role;

create policy "photos: owner selects own"
on public.photos
for select
to authenticated
using ((select auth.uid()) = owner_id);

-- The key is the row's own: `<prefix>library/<id>/original.<ext>`.
create policy "photos: owner inserts own uploading photo"
on public.photos
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and status = 'uploading'
  and r2_key ~ (
    '^([a-z0-9_-]+/)*library/' || id::text || '/original\.(jpg|png|heic|heif|webp)$'
  )
);

alter publication supabase_realtime add table public.photos;

-- jobs: a reel's job or a photo's describe job, never both.
alter table public.jobs
  alter column reel_id drop not null,
  add column photo_id uuid references public.photos (id) on delete cascade,
  drop constraint jobs_kind_check,
  add constraint jobs_kind_check check (
    kind in ('process', 'change', 'restore', 'render', 'describe_photo')
  ),
  add constraint jobs_target_check check (
    (reel_id is null) <> (photo_id is null)
    and (kind = 'describe_photo') = (photo_id is not null)
  );

create index jobs_photo_idx on public.jobs (photo_id, created_at);

-- steps: the job's reel or photo.
alter table public.steps
  alter column reel_id drop not null,
  add column photo_id uuid references public.photos (id) on delete cascade,
  add constraint steps_target_check check ((reel_id is null) <> (photo_id is null));

create index steps_photo_idx on public.steps (photo_id);

-- stored_files: an object a reel or a photo needs. One undeleted row per
-- photo and key, as per reel and key.
alter table public.stored_files
  alter column reel_id drop not null,
  add column photo_id uuid references public.photos (id) on delete cascade,
  add constraint stored_files_target_check check ((reel_id is null) <> (photo_id is null));

create unique index stored_files_live_photo_idx on public.stored_files (photo_id, r2_key)
  where deleted_at is null and photo_id is not null;

-- The owner is never trusted from the caller: it is the reel's or the photo's.
create or replace function public.stored_files_set_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.photo_id is not null then
    new.owner_id := (select p.owner_id from public.photos p where p.id = new.photo_id);
  else
    new.owner_id := (select r.owner_id from public.reels r where r.id = new.reel_id);
  end if;
  return new;
end;
$$;

-- As before, with the two targets compared null-safe: a photo row's reel_id
-- (and a reel row's photo_id) is null, and `=` on null would refuse the one
-- allowed update, recording the deletion.
create or replace function public.stored_files_refuse_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is null
    and new.deleted_at is not null
    and new.id = old.id
    and new.reel_id is not distinct from old.reel_id
    and new.photo_id is not distinct from old.photo_id
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

-- As in 20261101233625_storage_records.sql, except that a key any photo holds
-- is never a candidate: photo files are never slimmed.
create or replace function public.slim_rebuildable_files(p_now timestamptz, p_prefix text)
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
    having bool_and(f.kind = 'rebuildable' and f.photo_id is null)
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

-- Records that a photo needs an object, like record_stored_file for a reel. A
-- second call for the same photo and key adds nothing while the first row is
-- undeleted (a retried job).
create function public.record_photo_file(
  p_photo_id uuid,
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
  insert into public.stored_files (photo_id, step, r2_key, bytes, kind)
  values (p_photo_id, p_step, p_r2_key, p_bytes, p_kind)
  on conflict (photo_id, r2_key) where deleted_at is null and photo_id is not null do nothing;
$$;

revoke execute on function public.record_photo_file(uuid, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.record_photo_file(uuid, text, text, text, bigint)
  to service_role;

-- The owner's end of a photo upload: the uploading photo becomes `describing`
-- with the size storage reported, its original is recorded (`kept`) and one
-- describe_photo job is queued, in one transaction. A repeated call (a lost
-- answer) returns the photo's job and changes nothing.
create function public.finish_photo_upload(p_photo_id uuid, p_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_key text;
  v_owner uuid;
  v_job_id uuid;
begin
  if p_bytes is null or p_bytes not between 1 and 26214400 then
    raise exception 'p_bytes must be between 1 and 26214400' using errcode = '22023';
  end if;

  select status, r2_key, owner_id into v_status, v_key, v_owner
  from public.photos
  where id = p_photo_id
    and owner_id = (select auth.uid())
  for update;
  if not found then
    raise exception 'no photo of yours with this id' using errcode = 'P0002';
  end if;

  if v_status = 'uploading' then
    update public.photos
    set status = 'describing', bytes = p_bytes
    where id = p_photo_id;

    insert into public.stored_files (photo_id, owner_id, step, r2_key, bytes, kind)
    values (p_photo_id, v_owner, 'upload', v_key, p_bytes, 'kept')
    on conflict (photo_id, r2_key) where deleted_at is null and photo_id is not null do nothing;

    insert into public.jobs (photo_id, owner_id, kind)
    values (p_photo_id, v_owner, 'describe_photo')
    returning id into v_job_id;
    return v_job_id;
  end if;

  select id into v_job_id
  from public.jobs
  where photo_id = p_photo_id and kind = 'describe_photo'
  order by created_at, id
  limit 1;
  if v_job_id is null then
    raise exception 'no describe job for this photo' using errcode = 'P0002';
  end if;
  return v_job_id;
end;
$$;

revoke execute on function public.finish_photo_upload(uuid, bigint)
  from public, anon, service_role;
grant execute on function public.finish_photo_upload(uuid, bigint) to authenticated;

-- The owner deletes their own photo; its jobs, steps and stored-file rows go
-- with it through the cascade. The studio deletes the objects first.
create function public.delete_photo(p_photo_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.photos
  where id = p_photo_id
    and owner_id = (select auth.uid());
  if not found then
    raise exception 'no photo of yours with this id' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.delete_photo(uuid) from public, anon, service_role;
grant execute on function public.delete_photo(uuid) to authenticated;

-- claim_job as in 20261102040716_failures_and_footage_checks.sql, with the
-- per-target rule over the reel or the photo: one job per reel at a time, in
-- order, and one job per photo at a time, in order.
create or replace function public.claim_job(p_worker text, p_lease_seconds int)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker is null or length(trim(p_worker)) = 0 then
    raise exception 'p_worker must not be empty' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 1 and 3600 then
    raise exception 'p_lease_seconds must be between 1 and 3600' using errcode = '22023';
  end if;

  return query
  with next as (
    select c.id
    from public.jobs c
    where (
        c.status = 'queued'
        or (c.status = 'waiting_ai' and c.not_before <= now())
        or (c.status = 'running' and c.lease_expires_at < now())
      )
      and (c.not_before is null or c.not_before <= now())
      -- One job per reel or photo at a time, in order: no live job of the
      -- same target, and no older job of it still queued, running or waiting
      -- for the AI.
      and not exists (
        select 1 from public.jobs o
        where (o.reel_id = c.reel_id or o.photo_id = c.photo_id)
          and o.id <> c.id
          and (
            (o.status = 'running' and o.lease_expires_at >= now())
            or (
              o.status in ('queued', 'running', 'waiting_ai')
              and (o.created_at, o.id) < (c.created_at, c.id)
            )
          )
      )
    order by c.created_at, c.id
    limit 1
    for update of c skip locked
  )
  update public.jobs j
  set status = 'running',
      lease_holder = p_worker,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = j.attempts + 1,
      started_at = now(),
      waiting_reason = null,
      not_before = null
  from next
  where j.id = next.id
  returning j.*;
end;
$$;

revoke execute on function public.claim_job(text, int) from public, anon, authenticated;
grant execute on function public.claim_job(text, int) to service_role;
