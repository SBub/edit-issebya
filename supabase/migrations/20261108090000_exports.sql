-- Exports: an owner may queue a render of a version of their own processed
-- reel (pinned through jobs.version_id); the worker renders it, stores the MP4
-- and records it in exports, which lives for 24 hours. Owners read their own
-- exports; only the worker (secret key) writes them. A render never moves
-- current_version_id, so it does not count as active for the interim
-- change-or-restore rule.

alter table public.jobs
  drop constraint jobs_kind_check,
  add constraint jobs_kind_check check (kind in ('process', 'change', 'restore', 'render'));

-- Versions are never deleted except by the reel's cascade, which removes the
-- reel's jobs too, so the reference needs no on delete rule.
alter table public.jobs
  add column version_id uuid references public.versions (id);

-- A render carries the version it exports; no other kind carries one.
alter table public.jobs
  add constraint jobs_version_check check ((kind = 'render') = (version_id is not null));

grant insert (reel_id, kind, request, restore_version_id, version_id) on public.jobs to authenticated;

-- A render is pinned to its version and never moves the current one, so it
-- does not block a change or a restore.
create or replace function public.reel_has_active_job(p_reel_id uuid)
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
      and j.kind <> 'render'
  );
$$;

revoke execute on function public.reel_has_active_job(uuid) from public, anon, service_role;
grant execute on function public.reel_has_active_job(uuid) to authenticated;

-- One active render per version: a security definer function, since a policy
-- on public.jobs cannot read public.jobs (42P17). It only answers for the
-- caller's own reels.
create function public.reel_has_active_render(p_reel_id uuid, p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.jobs j
    where j.reel_id = p_reel_id
      and j.version_id = p_version_id
      and j.owner_id = (select auth.uid())
      and j.kind = 'render'
      and j.status in ('queued', 'running')
  );
$$;

revoke execute on function public.reel_has_active_render(uuid, uuid) from public, anon, service_role;
grant execute on function public.reel_has_active_render(uuid, uuid) to authenticated;

create policy "jobs: owner queues a render of a version of own processed reel"
on public.jobs
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and kind = 'render'
  and status = 'queued'
  and exists (
    select 1 from public.reels r
    where r.id = jobs.reel_id
      and r.owner_id = (select auth.uid())
      and r.status = 'processed'
  )
  and exists (
    select 1 from public.versions v
    where v.id = jobs.version_id and v.reel_id = jobs.reel_id
  )
  and not public.reel_has_active_render(jobs.reel_id, jobs.version_id)
);

create table public.exports (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid not null references public.reels (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,
  version_id uuid not null references public.versions (id),
  r2_key text not null unique,
  bytes bigint not null check (bytes > 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index exports_reel_idx on public.exports (reel_id, created_at);

-- An export lives exactly 24 hours from its creation, whatever the writer
-- sends. A trigger, not a generated column: timestamptz + interval is only
-- stable, not immutable.
create function public.exports_set_expiry()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.expires_at := new.created_at + interval '24 hours';
  return new;
end;
$$;

create trigger exports_set_expiry
before insert or update on public.exports
for each row execute function public.exports_set_expiry();

alter table public.exports enable row level security;

revoke all on public.exports from anon;
revoke all on public.exports from authenticated;
grant select on public.exports to authenticated;

create policy "exports: owner selects own"
on public.exports
for select
to authenticated
using ((select auth.uid()) = owner_id);

alter publication supabase_realtime add table public.exports;
