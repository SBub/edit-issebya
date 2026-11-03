-- One-step export (app_docs/export.md). Export is one action: the studio queues
-- the render, shows its progress and downloads the file by itself when the
-- `exports` row arrives, so the file is only a hand-over. Three changes:
--
-- 1. A new job status, `cancelled`, set only through `cancel_job`: the owner
--    of a reel may cancel their own `render` job while it is `queued`,
--    `running` or `waiting_ai` and has no export yet. Owners still have no
--    general update right on `jobs`. claim_job is unchanged: it claims only
--    `queued`, `waiting_ai` past its `not_before` and `running` with an
--    expired lease, so a cancelled job is never claimed, and a cancelled job
--    holds no other job of its reel back.
-- 2. An export is never recorded for a cancelled job: the insert trigger locks
--    the job row and refuses the row when the job is cancelled. cancel_job
--    locks the same row and refuses once an export exists, so a render either
--    finishes with its export or is cancelled without one, never both.
-- 3. A new export's file lives 1 hour (was 24 hours). Existing rows keep their
--    value: the new expiry check is added `not valid`, so it holds for every
--    new row and leaves the old ones as they are. The slimming deletes expired
--    export files as before (`expire_export_files`), and `discard_export_file`
--    lets the worker remove an export file it uploaded but could not record
--    (the job was cancelled or the insert failed).

alter table public.jobs
  drop constraint jobs_status_check,
  add constraint jobs_status_check check (
    status in ('queued', 'running', 'waiting_ai', 'done', 'failed', 'cancelled')
  );

alter table public.exports
  drop constraint exports_check,
  add constraint exports_expiry_check check (expires_at = created_at + interval '1 hour') not valid;

-- The expiry and the owner are never trusted from the caller; a cancelled
-- job's export is refused. `for share` waits for a cancel_job in progress on
-- the same job and keeps one from starting until this insert commits.
create or replace function public.exports_set_owner_and_expiry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select j.status into v_status
  from public.jobs j
  where j.id = new.job_id
  for share;
  if v_status = 'cancelled' then
    raise exception 'export refused: the job was cancelled' using errcode = '55000';
  end if;
  new.expires_at := new.created_at + interval '1 hour';
  new.owner_id := (select r.owner_id from public.reels r where r.id = new.reel_id);
  return new;
end;
$$;

revoke execute on function public.exports_set_owner_and_expiry() from public, anon, authenticated;

-- Cancels the caller's own render job while it is queued, running or waiting
-- for the AI and has no export yet. True when it was cancelled, false
-- otherwise (not the caller's, not a render, already finished, or its export
-- already recorded), never saying which. The job ends `cancelled` with
-- `finished_at`, its lease and waiting columns cleared; the worker running it
-- sees the status and stops writing (app_docs/export.md).
create function public.cancel_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_job record;
begin
  if v_uid is null or p_job_id is null then
    return false;
  end if;
  -- Locks the row first: an export insert in progress commits before the
  -- check below reads `exports` (a new snapshot per statement).
  select j.id, j.kind, j.status, j.owner_id, j.reel_id into v_job
  from public.jobs j
  where j.id = p_job_id
  for update;
  if not found
    or v_job.owner_id <> v_uid
    or v_job.kind <> 'render'
    or v_job.status not in ('queued', 'running', 'waiting_ai')
    or not exists (
      select 1 from public.reels r where r.id = v_job.reel_id and r.owner_id = v_uid
    )
  then
    return false;
  end if;
  if exists (select 1 from public.exports e where e.job_id = p_job_id) then
    return false;
  end if;
  update public.jobs
  set status = 'cancelled',
      finished_at = now(),
      lease_expires_at = null,
      waiting_reason = null,
      not_before = null
  where id = p_job_id;
  return true;
end;
$$;

revoke execute on function public.cancel_job(uuid) from public, anon, authenticated;
grant execute on function public.cancel_job(uuid) to authenticated;

-- Marks deleted and returns an export file under the prefix that no export
-- records (the worker uploaded it, then the job was cancelled or the row was
-- not written). A recorded export's file is never returned: it expires through
-- expire_export_files. Selection and marking are one statement.
create function public.discard_export_file(p_r2_key text)
returns table (r2_key text, bytes bigint)
language sql
security definer
set search_path = ''
as $$
  with marked as (
    update public.stored_files f
    set deleted_at = greatest(now(), f.created_at)
    where f.deleted_at is null
      and f.kind = 'export'
      and f.r2_key = p_r2_key
      and not exists (select 1 from public.exports e where e.r2_key = p_r2_key)
    returning f.r2_key, f.bytes
  )
  select m.r2_key, max(m.bytes)
  from marked m
  group by m.r2_key;
$$;

revoke execute on function public.discard_export_file(text) from public, anon, authenticated;
grant execute on function public.discard_export_file(text) to service_role;
