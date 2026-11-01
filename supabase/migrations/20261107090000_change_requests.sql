-- Change requests: an owner may now queue a change (their own words, decided
-- by the AI from the current version) or a restore (an earlier version of the
-- same reel, copied into a new version) for their own processed reel. Status,
-- lease and attempts stay the worker's: the insert grant names only the
-- columns the policies check. reels is already in the Realtime publication
-- (the skeleton migration), so it is not added again.

alter table public.jobs
  drop constraint jobs_kind_check,
  add constraint jobs_kind_check check (kind in ('process', 'change', 'restore'));

-- Versions are never deleted except by the reel's cascade, which removes the
-- reel's jobs too, so the reference needs no on delete rule.
alter table public.jobs
  add column request text,
  add column restore_version_id uuid references public.versions (id);

-- A change carries its words, trimmed, 1 to 1000 characters; no other kind
-- carries any.
alter table public.jobs
  add constraint jobs_request_check check (
    (kind = 'change') = (request is not null)
    and (request is null or (request = btrim(request) and char_length(request) between 1 and 1000))
  ),
  add constraint jobs_restore_check check ((kind = 'restore') = (restore_version_id is not null));

grant insert (reel_id, kind, request, restore_version_id) on public.jobs to authenticated;

-- The interim ordering rule: a change or restore only for a processed reel with
-- no queued or running job, so a reel never has two active jobs. Slice 16
-- replaces it with ordering enforced by the queue itself. A restore target must
-- be a version of the same reel.
create policy "jobs: owner inserts a change or restore job for own processed reel"
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
  and not exists (
    select 1 from public.jobs j
    where j.reel_id = jobs.reel_id and j.status in ('queued', 'running')
  )
  and (
    jobs.restore_version_id is null
    or exists (
      select 1 from public.versions v
      where v.id = jobs.restore_version_id and v.reel_id = jobs.reel_id
    )
  )
);
