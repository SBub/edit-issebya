-- The change-or-restore insert policy read public.jobs from inside a policy on
-- public.jobs, which Postgres refuses as infinite recursion (42P17) on every
-- insert. The interim ordering rule's "no queued or running job" now goes
-- through a security definer function, which reads jobs without RLS. It only
-- answers for the caller's own reels, so it says nothing about anyone else's.

create function public.reel_has_active_job(p_reel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.jobs j
    where j.reel_id = p_reel_id
      and j.owner_id = (select auth.uid())
      and j.status in ('queued', 'running')
  );
$$;

-- Supabase's default privileges grant execute on new public functions to
-- anon, authenticated and service_role explicitly, so revoking from public
-- alone is not enough.
revoke execute on function public.reel_has_active_job(uuid) from public, anon, service_role;
grant execute on function public.reel_has_active_job(uuid) to authenticated;

drop policy "jobs: owner queues a change or restore for own processed reel" on public.jobs;

-- The interim ordering rule: a change or restore only for a processed reel with
-- no queued or running job, so a reel never has two active jobs. Slice 16
-- replaces it with ordering enforced by the queue itself. A restore target must
-- be a version of the same reel.
create policy "jobs: owner queues a change or restore for own processed reel"
on public.jobs
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and kind in ('change', 'restore')
  and status = 'queued'
  and exists (
    select 1 from public.reels r
    where r.id = jobs.reel_id
      and r.owner_id = (select auth.uid())
      and r.status = 'processed'
  )
  and not public.reel_has_active_job(jobs.reel_id)
  and (
    jobs.restore_version_id is null
    or exists (
      select 1 from public.versions v
      where v.id = jobs.restore_version_id and v.reel_id = jobs.reel_id
    )
  )
);
