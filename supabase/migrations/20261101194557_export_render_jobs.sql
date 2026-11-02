-- Export (slice 12). A fourth job kind, `render`, names a version of the same
-- reel (`version_id`) and the worker renders it to an MP4. The owner inserts it
-- through a column-limited grant and its own policy. Each finished render is
-- an `exports` row: written only by the worker (service role), never updated,
-- its owner taken from the reel and its expiry fixed at 24 hours after it was
-- made, both by a trigger whatever the insert passes. Owners read their own.

alter table public.jobs
  drop constraint jobs_kind_check,
  add constraint jobs_kind_check check (kind in ('process', 'change', 'restore', 'render')),
  add column version_id uuid,
  -- A render names a version of its own reel (`versions` has unique (id, reel_id)).
  add constraint jobs_version_fkey foreign key (version_id, reel_id)
    references public.versions (id, reel_id) on delete cascade,
  -- A render names the version to export; no other kind names one.
  add constraint jobs_version_check check ((kind = 'render') = (version_id is not null));

-- The existing (reel_id, kind) and (request, restore_version_id) grants stay.
grant insert (version_id) on public.jobs to authenticated;

-- The `process` and the change or restore policies are unchanged, so neither
-- can carry a version_id (the check refuses it too).
create policy "jobs: owner inserts a render job for own reel"
on public.jobs
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and status = 'queued'
  and kind = 'render'
  and exists (
    select 1 from public.reels r
    where r.id = jobs.reel_id and r.owner_id = (select auth.uid())
  )
  and exists (
    select 1 from public.versions v
    where v.id = jobs.version_id and v.reel_id = jobs.reel_id
  )
);

create table public.exports (
  id uuid primary key,
  reel_id uuid not null references public.reels (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null unique references public.jobs (id) on delete cascade,
  version_id uuid not null,
  r2_key text not null unique,
  bytes bigint not null check (bytes > 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  foreign key (version_id, reel_id) references public.versions (id, reel_id) on delete cascade,
  check (expires_at = created_at + interval '24 hours')
);

create index exports_reel_idx on public.exports (reel_id, created_at desc);

-- The expiry and the owner are never trusted from the caller.
create function public.exports_set_owner_and_expiry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.expires_at := new.created_at + interval '24 hours';
  new.owner_id := (select r.owner_id from public.reels r where r.id = new.reel_id);
  return new;
end;
$$;

revoke execute on function public.exports_set_owner_and_expiry() from public, anon, authenticated;

create trigger exports_before_insert
before insert on public.exports
for each row execute function public.exports_set_owner_and_expiry();

-- An export never changes, not even for the service role. Deletes stay
-- possible for the service role and through the reel's cascade.
create function public.refuse_export_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'exports are immutable: export again instead'
    using errcode = '55000';
end;
$$;

create trigger exports_refuse_update
before update on public.exports
for each row execute function public.refuse_export_update();

alter table public.exports enable row level security;

-- Defence in depth beside RLS: no anon access; authenticated may only read.
-- The worker inserts with the secret key (service role): no insert policy.
revoke all on public.exports from anon;
revoke all on public.exports from authenticated;
grant select on public.exports to authenticated;

create policy "exports: owner selects own"
on public.exports
for select
to authenticated
using ((select auth.uid()) = owner_id);

-- Realtime delivers row changes, filtered by the same RLS policy.
alter publication supabase_realtime add table public.exports;
