-- Resumable multipart upload of the source clip straight to R2. A reel carries
-- the id of its one multipart upload, so the studio's server can always tie the
-- upload back to the reel (the browser never chooses the key or the upload id).
-- finish_upload becomes idempotent: a repeated completion returns the same
-- process job and queues nothing. fail_upload marks a cancelled upload failed.

-- R2's upload ids are opaque; this is wide enough for them and admits no slash
-- and no query character (the length is checked apart: Postgres regex bounds
-- stop at 255).
alter table public.reels
  add column source_upload_id text
  constraint reels_source_upload_id_check
    check (
      source_upload_id is null
      or (source_upload_id ~ '^[A-Za-z0-9._~-]+$' and length(source_upload_id) <= 1024)
    );

-- One reel per upload id; the studio looks the reel up by it.
create unique index reels_source_upload_id_idx on public.reels (source_upload_id)
  where source_upload_id is not null;

-- The existing insert policy ("reels: owner inserts own uploading reel") still
-- applies: only the owner's own uploading reel.
grant insert (source_upload_id) on public.reels to authenticated;

-- The one way an owner finishes an upload. Their own uploading reel becomes
-- uploaded with its size and one process job is queued. A second call (a
-- retried completion) returns that same job and inserts nothing; the row lock
-- makes two concurrent calls queue, so the second sees `uploaded`. Another
-- owner's reel, a failed reel and a call without a user all fail the same way.
create or replace function public.finish_upload(p_reel_id uuid, p_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_job_id uuid;
begin
  if p_bytes is null or p_bytes < 1 then
    raise exception 'p_bytes must be at least 1' using errcode = '22023';
  end if;

  select status into v_status
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

-- A cancelled upload: the caller's own uploading reel becomes failed. Already
-- failed is a no-op; any other state, another owner's reel and a call without
-- a user fail the same way.
create function public.fail_upload(p_reel_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status
  from public.reels
  where id = p_reel_id
    and owner_id = (select auth.uid())
  for update;
  if not found or v_status not in ('uploading', 'failed') then
    raise exception 'no uploading reel of yours with this id' using errcode = 'P0002';
  end if;

  if v_status = 'uploading' then
    update public.reels set status = 'failed' where id = p_reel_id;
  end if;
end;
$$;

revoke execute on function public.fail_upload(uuid) from public, anon, service_role;
grant execute on function public.fail_upload(uuid) to authenticated;
