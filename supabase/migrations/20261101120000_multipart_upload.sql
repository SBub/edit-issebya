-- Multipart upload (app_docs/upload.md): the browser may call completion more
-- than once (a retry, a resumed upload, two tabs), so finish_upload becomes
-- idempotent: one reel, one process job, however many calls. abort_upload is
-- the owner's second narrow status path: their own uploading reel becomes
-- failed when they cancel. Owners still never update reels directly.

-- Locks the owner's reel row so concurrent calls serialise: the first moves an
-- uploading reel to uploaded and queues its process job, every later call
-- answers that job's id. Another owner's reel, a reel past uploading without a
-- job and a call without a user all fail the same way.
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
  if not found then
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

  select id into v_job_id
  from public.jobs
  where reel_id = p_reel_id and kind = 'process'
  order by created_at, id
  limit 1;
  if v_job_id is null then
    raise exception 'no uploading reel of yours with this id' using errcode = 'P0002';
  end if;
  return v_job_id;
end;
$$;

-- create or replace keeps the grants; restated so this file says who may call it.
revoke execute on function public.finish_upload(uuid, bigint) from public, anon, service_role;
grant execute on function public.finish_upload(uuid, bigint) to authenticated;

-- The owner cancels their own upload: an uploading reel becomes failed (the row
-- stays, owners never delete reels). Calling it again on the failed reel is
-- harmless; any other reel or state, and a call without a user, fail.
create function public.abort_upload(p_reel_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.reels
  set status = 'failed'
  where id = p_reel_id
    and owner_id = (select auth.uid())
    and status = 'uploading';
  if found then
    return;
  end if;

  perform 1
  from public.reels
  where id = p_reel_id
    and owner_id = (select auth.uid())
    and status = 'failed';
  if not found then
    raise exception 'no uploading reel of yours with this id' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.abort_upload(uuid) from public, anon, service_role;
grant execute on function public.abort_upload(uuid) to authenticated;
