-- Job queue: one row per job (a reel's processing run) and one row per step a
-- job runs. Only the worker (secret key) writes job and step state; owners read
-- their own rows through RLS and write only through two narrow paths: a
-- column-limited insert of an uploading reel, and finish_upload, which moves
-- that reel to uploaded and queues its process job in one transaction.

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid not null references public.reels (id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Named so later migrations can drop and re-add it with more kinds.
  kind text not null default 'process' constraint jobs_kind_check check (kind in ('process')),
  status text not null default 'queued'
    constraint jobs_status_check check (status in ('queued', 'running', 'done', 'failed')),
  lease_holder text,
  lease_expires_at timestamptz,
  attempts int not null default 0 check (attempts >= 0),
  error_tail text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index jobs_reel_idx on public.jobs (reel_id, created_at);
create index jobs_claimable_idx on public.jobs (created_at, id)
  where status in ('queued', 'running');

create table public.steps (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  reel_id uuid not null references public.reels (id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  status text not null default 'running'
    constraint steps_status_check check (status in ('running', 'done', 'failed')),
  summary text,
  error_tail text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index steps_reel_idx on public.steps (reel_id, started_at);

alter table public.jobs enable row level security;
alter table public.steps enable row level security;

-- Defence in depth beside RLS: no anon access at all; authenticated reads, and
-- may insert only the columns the policies below check.
revoke all on public.jobs, public.steps from anon;
revoke all on public.jobs, public.steps from authenticated;
grant select on public.jobs, public.steps to authenticated;
grant insert (reel_id, kind) on public.jobs to authenticated;

-- The owner creates their reel row before uploading; status, owner_id and
-- source_bytes come from their defaults. Still no update or delete grant.
grant insert (id, source_name, source_key) on public.reels to authenticated;

create policy "jobs: owner selects own"
on public.jobs
for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "steps: owner selects own"
on public.steps
for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "jobs: owner inserts a process job for own reel"
on public.jobs
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and kind = 'process'
  and status = 'queued'
  and exists (
    select 1 from public.reels r
    where r.id = reel_id and r.owner_id = (select auth.uid())
  )
);

-- The key must end with this reel's own path, so it never names another
-- reel's object.
create policy "reels: owner inserts own uploading reel"
on public.reels
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and status = 'uploading'
  and source_bytes is null
  and (
    source_key is null
    or source_key ~ ('^[a-z0-9/_-]*reels/' || id::text || '/source/original\.[a-z0-9]{1,8}$')
  )
);

-- The one way an owner finishes an upload: their own uploading reel becomes
-- uploaded with its size, and one process job is queued. Another owner's reel,
-- a reel in any other state and a call without a user all fail the same way.
create function public.finish_upload(p_reel_id uuid, p_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id uuid;
begin
  if p_bytes is null or p_bytes < 1 then
    raise exception 'p_bytes must be at least 1' using errcode = '22023';
  end if;

  update public.reels
  set status = 'uploaded', source_bytes = p_bytes
  where id = p_reel_id
    and owner_id = (select auth.uid())
    and status = 'uploading'
    and source_key is not null;
  if not found then
    raise exception 'no uploading reel of yours with this id' using errcode = 'P0002';
  end if;

  insert into public.jobs (reel_id, owner_id, kind)
  values (p_reel_id, (select auth.uid()), 'process')
  returning id into v_job_id;
  return v_job_id;
end;
$$;

-- Supabase's default privileges grant execute on new public functions to
-- anon, authenticated and service_role explicitly, so revoking from public
-- alone is not enough.
revoke execute on function public.finish_upload(uuid, bigint) from public, anon, service_role;
grant execute on function public.finish_upload(uuid, bigint) to authenticated;

-- Claims the oldest claimable job (queued, or running with an expired lease)
-- for one worker, with a lease and one more attempt. skip locked lets two
-- workers claim at once without taking the same job.
create function public.claim_job(p_worker text, p_lease_seconds int)
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
    where c.status = 'queued' or (c.status = 'running' and c.lease_expires_at < now())
    order by c.created_at, c.id
    limit 1
    for update skip locked
  )
  update public.jobs j
  set status = 'running',
      lease_holder = p_worker,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = j.attempts + 1,
      started_at = now()
  from next
  where j.id = next.id
  returning j.*;
end;
$$;

revoke execute on function public.claim_job(text, int) from public, anon, authenticated;
grant execute on function public.claim_job(text, int) to service_role;

-- Realtime delivers row changes, filtered by the same RLS policies.
alter publication supabase_realtime add table public.jobs, public.steps;
