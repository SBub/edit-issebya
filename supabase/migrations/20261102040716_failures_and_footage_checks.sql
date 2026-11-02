-- Failures and footage checks (slice 16, app_docs/failures.md). Every process
-- job starts by checking the footage; a clip the studio cannot take leaves the
-- reel `refused` with a human message (`checking_footage` while it is
-- checked). A job whose AI is not available waits (`waiting_ai`) with its
-- reason until `not_before`, and its step row is `waiting`. A failed job may
-- be retried by its owner: a new job of the same reel, kind and parameters
-- naming it in `retry_of_job_id`, once. claim_job takes one job per reel at a
-- time, in order, and skips a job until its `not_before`. Owners still never
-- write reel or job status.

alter table public.reels
  drop constraint reels_status_check,
  add constraint reels_status_check check (
    status in (
      'uploading',
      'uploaded',
      'checking_footage',
      'received',
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
  add column refusal_message text check (
    refusal_message is null or char_length(refusal_message) between 1 and 300
  ),
  -- A refused reel says why; no other reel carries a refusal message.
  add constraint reels_refusal_check check ((status = 'refused') = (refusal_message is not null));

alter table public.jobs
  drop constraint jobs_status_check,
  add constraint jobs_status_check check (
    status in ('queued', 'running', 'waiting_ai', 'done', 'failed')
  ),
  add column waiting_reason text check (
    waiting_reason is null or char_length(waiting_reason) between 1 and 200
  ),
  add column not_before timestamptz,
  add column retry_of_job_id uuid references public.jobs (id) on delete set null,
  -- A waiting job says why and until when; no other job does.
  add constraint jobs_waiting_check check (
    (status = 'waiting_ai') = (waiting_reason is not null)
    and (status = 'waiting_ai') = (not_before is not null)
  );

-- One retry per failed job, so a double click queues one job.
create unique index jobs_retry_of_job_id_key on public.jobs (retry_of_job_id)
  where retry_of_job_id is not null;

drop index public.jobs_claimable_idx;
create index jobs_claimable_idx on public.jobs (created_at, id)
  where status in ('queued', 'running', 'waiting_ai');

alter table public.steps
  drop constraint steps_status_check,
  add constraint steps_status_check check (
    status in ('running', 'done', 'failed', 'skipped', 'waiting')
  );

-- The existing insert grants stay; the owner may also name the job retried.
grant insert (retry_of_job_id) on public.jobs to authenticated;

-- Whether a retry names a failed job of the caller's, of the same reel, kind
-- and parameters. Security definer: a policy on `jobs` reading `jobs` directly
-- is refused as infinite recursion, so the owner check is made here instead.
create function public.is_retry_of_failed_job(
  p_retry_of uuid,
  p_reel_id uuid,
  p_kind text,
  p_request text,
  p_restore_version_id uuid,
  p_version_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.jobs f
    where f.id = p_retry_of
      and f.owner_id = (select auth.uid())
      and f.reel_id = p_reel_id
      and f.status = 'failed'
      and f.kind = p_kind
      and f.request is not distinct from p_request
      and f.restore_version_id is not distinct from p_restore_version_id
      and f.version_id is not distinct from p_version_id
  );
$$;

revoke execute on function public.is_retry_of_failed_job(uuid, uuid, text, text, uuid, uuid)
  from public, anon, service_role;
grant execute on function public.is_retry_of_failed_job(uuid, uuid, text, text, uuid, uuid)
  to authenticated;

-- Restrictive: applies on top of every permissive insert policy (process,
-- change or restore, render). A retry names a failed job of the owner's, of
-- the same reel with the same kind and parameters.
create policy "jobs: a retry names a failed job of the same reel, kind and parameters"
on public.jobs
as restrictive
for insert
to authenticated
with check (
  retry_of_job_id is null
  or public.is_retry_of_failed_job(
    retry_of_job_id, reel_id, kind, request, restore_version_id, version_id
  )
);

-- Claims the oldest claimable job for one worker, with a lease and one more
-- attempt: queued, waiting for the AI past its `not_before`, or running with an
-- expired lease. One job per reel at a time, in order: a job is skipped while
-- another job of its reel is running under a live lease, or while an older job
-- of its reel is still queued, running or waiting for the AI. Two workers
-- claiming at once cannot run two jobs of a reel: the second skips the row the
-- first has locked and still sees it `queued` (older than its sibling), so it
-- skips the sibling too. The claim clears the waiting reason and `not_before`.
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
      -- One job per reel at a time, in order: no live job of the reel, and no
      -- older job of the reel still queued, running or waiting for the AI.
      and not exists (
        select 1 from public.jobs o
        where o.reel_id = c.reel_id
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
