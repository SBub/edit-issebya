-- Change requests and going back (slice 11). Two job kinds join `process`:
-- `change` carries the owner's words (`request`) and the worker runs only the
-- decide step with them; `restore` names an earlier version of the same reel
-- (`restore_version_id`) and the worker saves a new version copying it. The
-- owner inserts both through a column-limited grant and one policy; status,
-- lease, attempts and error columns stay the worker's alone.

alter table public.jobs
  drop constraint jobs_kind_check,
  add constraint jobs_kind_check check (kind in ('process', 'change', 'restore')),
  add column request text,
  add column restore_version_id uuid references public.versions (id) on delete cascade,
  -- A change carries 1 to 1000 trimmed characters; no other kind carries any.
  add constraint jobs_request_check check (
    (kind = 'change') = (request is not null)
    and (
      request is null
      or (request = btrim(request) and char_length(request) between 1 and 1000)
    )
  ),
  -- A restore names the version to go back to; no other kind names one.
  add constraint jobs_restore_version_check check (
    (kind = 'restore') = (restore_version_id is not null)
  );

-- The existing (reel_id, kind) grant stays; owner_id comes from its default.
grant insert (request, restore_version_id) on public.jobs to authenticated;

-- The `process` policy is unchanged. A restore may name only a version of the
-- same reel (qualified: `versions` has a `reel_id` of its own).
create policy "jobs: owner inserts a change or restore job for own reel"
on public.jobs
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and status = 'queued'
  and kind in ('change', 'restore')
  and exists (
    select 1 from public.reels r
    where r.id = jobs.reel_id and r.owner_id = (select auth.uid())
  )
  and (
    kind <> 'restore'
    or exists (
      select 1 from public.versions v
      where v.id = jobs.restore_version_id and v.reel_id = jobs.reel_id
    )
  )
);
