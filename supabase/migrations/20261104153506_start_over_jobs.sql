-- Start over (a temporary testing control, to be removed). One more job kind,
-- `start_over`, reruns the reel's first edit from the decide step: the worker
-- decides again from version 1 (captions only) with no request and saves a new
-- version. It carries no request, no version and no photo (the existing
-- checks refuse any). The owner inserts it through the existing (reel_id,
-- kind) grant and its own policy; status, lease, attempt and error columns
-- stay the worker's. No new table and no new column, so no new grant.

alter table public.jobs
  drop constraint jobs_kind_check,
  add constraint jobs_kind_check check (
    kind in ('process', 'change', 'restore', 'render', 'describe_photo', 'start_over')
  );

-- The other insert policies are unchanged. The restrictive retry policy
-- applies on top, so Try again on a failed start over works as for a change.
create policy "jobs: owner inserts a start over job for own reel"
on public.jobs
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and status = 'queued'
  and kind = 'start_over'
  and exists (
    select 1 from public.reels r
    where r.id = jobs.reel_id and r.owner_id = (select auth.uid())
  )
);
