-- Failures and footage checks (slice 16, app_docs/failures.md). A job that waits for the AI
-- (`waiting_ai`, with its reason and the time of its next try), a retry of a failed job
-- (`retry_of_job_id`, inserted by the owner, checked by a trigger, once per failed job), a step
-- row that waits for the AI, the reel statuses of the footage check (`checking_footage`, and
-- `refused` with its message), and `claim_job` rewritten: one job at a time per reel, in order,
-- and a waiting job only once its time has come.

alter table public.jobs
  drop constraint jobs_status_check,
  add constraint jobs_status_check check (
    status in ('queued', 'running', 'waiting_ai', 'done', 'failed')
  ),
  add column waiting_reason text,
  add column not_before timestamptz,
  -- A waiting job always says why and until when; no other job does.
  add constraint jobs_waiting_check check (
    (status = 'waiting_ai') = (waiting_reason is not null and not_before is not null)
  ),
  add column retry_of_job_id uuid references public.jobs (id) on delete set null;

-- A failed job is retried once: a double click inserts nothing more.
create unique index jobs_retry_of_idx on public.jobs (retry_of_job_id)
  where retry_of_job_id is not null;

-- The existing (reel_id, kind), (request, restore_version_id) and (version_id) grants stay; the
-- insert policies are unchanged (own reel, kind-specific columns), the trigger below checks the
-- retry itself.
grant insert (retry_of_job_id) on public.jobs to authenticated;

-- A retry names a failed job of the same reel, of the same kind with the same parameters, whose
-- reel was not refused. Anything else is refused, whoever inserts it.
create function public.jobs_check_retry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  if new.retry_of_job_id is null then
    return new;
  end if;
  select true into v_ok
  from public.jobs o
  join public.reels r on r.id = o.reel_id
  where o.id = new.retry_of_job_id
    and o.status = 'failed'
    and o.reel_id = new.reel_id
    and o.kind = new.kind
    and o.request is not distinct from new.request
    and o.restore_version_id is not distinct from new.restore_version_id
    and o.version_id is not distinct from new.version_id
    and r.status <> 'refused';
  if v_ok is null then
    raise exception 'a retry names a failed job of the same reel, kind and parameters'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.jobs_check_retry() from public, anon, authenticated;

create trigger jobs_check_retry_before_insert
before insert on public.jobs
for each row execute function public.jobs_check_retry();

alter table public.steps
  drop constraint steps_status_check,
  add constraint steps_status_check check (
    status in ('running', 'done', 'failed', 'skipped', 'waiting_ai')
  );

alter table public.reels
  drop constraint reels_status_check,
  add constraint reels_status_check check (
    status in (
      'uploading',
      'uploaded',
      'received',
      'checking_footage',
      'converting',
      'transcribing',
      'retiming',
      'removing_background',
      'tracking_head',
      'making_previews',
      'processed',
      'failed',
      'refused'
    )
  ),
  add column refusal_message text,
  -- A refused reel always says why; no other reel carries a refusal.
  add constraint reels_refusal_check check ((status = 'refused') = (refusal_message is not null));

drop index public.jobs_claimable_idx;
create index jobs_claimable_idx on public.jobs (created_at, id)
  where status in ('queued', 'running', 'waiting_ai');

-- Claims the oldest claimable job (queued, running with an expired lease, or waiting for the AI
-- past its next try) whose reel has no running job with a live lease and no older unfinished
-- job, for one worker, with a lease and one more attempt. skip locked lets two workers claim at
-- once without taking the same job.
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
        or (c.status = 'running' and c.lease_expires_at < now())
        or (c.status = 'waiting_ai' and c.not_before <= now())
      )
      -- One job at a time per reel, in order (app_docs/failures.md).
      and not exists (
        select 1 from public.jobs o
        where o.reel_id = c.reel_id
          and o.id <> c.id
          and (
            (o.status = 'running' and o.lease_expires_at >= now())
            or (
              (o.created_at, o.id) < (c.created_at, c.id)
              and o.status in ('queued', 'running', 'waiting_ai')
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

-- The worker's lease-held running job waits for the AI: its reason, and its next try counted
-- from the database clock. False when the worker no longer holds the lease.
create function public.wait_for_ai(
  p_job_id uuid,
  p_worker text,
  p_reason text,
  p_retry_after_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 200 then
    raise exception 'p_reason must be 1 to 200 characters' using errcode = '22023';
  end if;
  if p_retry_after_seconds is null or p_retry_after_seconds not between 60 and 86400 then
    raise exception 'p_retry_after_seconds must be between 60 and 86400' using errcode = '22023';
  end if;

  update public.jobs
  set status = 'waiting_ai',
      waiting_reason = btrim(p_reason),
      not_before = now() + make_interval(secs => p_retry_after_seconds),
      lease_holder = null,
      lease_expires_at = null
  where id = p_job_id
    and lease_holder = p_worker
    and status = 'running';
  return found;
end;
$$;

revoke execute on function public.wait_for_ai(uuid, text, text, int)
  from public, anon, authenticated;
grant execute on function public.wait_for_ai(uuid, text, text, int) to service_role;
