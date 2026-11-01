-- Versions: every edit of a reel is an immutable version. The edit itself
-- (edit.json) lives in R2 at r2_key, written once; the row holds its
-- metadata: parent, restored-from, the request and model that made it, the
-- builder's checks and the input fingerprints. reels.current_version_id names
-- the current one. Going back creates a new version; rows never change.
-- Owners read their own versions; only the worker (service role) saves one,
-- through save_version.

create table public.versions (
  id uuid primary key,
  reel_id uuid not null references public.reels (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- "version N": 1, 2, 3 per reel, given by save_version.
  number int not null check (number >= 1),
  parent_id uuid,
  restored_from_id uuid,
  request text,
  model text,
  prompt_version text,
  change_summary text,
  checks jsonb not null default '[]'::jsonb check (jsonb_typeof(checks) = 'array'),
  inputs jsonb not null check (jsonb_typeof(inputs) = 'object'),
  r2_key text not null unique,
  created_at timestamptz not null default now(),
  -- Doubles as a guard against two concurrent saves.
  unique (reel_id, number),
  -- The target of the same-reel foreign keys below.
  unique (id, reel_id),
  -- A parent and a restored-from version are versions of the same reel.
  foreign key (parent_id, reel_id) references public.versions (id, reel_id),
  foreign key (restored_from_id, reel_id) references public.versions (id, reel_id)
);

create index versions_reel_idx on public.versions (reel_id, number);

-- The current version, of this reel only.
alter table public.reels add column current_version_id uuid;
alter table public.reels
  add constraint reels_current_version_fkey
  foreign key (current_version_id, id) references public.versions (id, reel_id)
  on delete set null (current_version_id);

-- Rows never change, not even for the service role. They go only with their
-- reel (the cascade).
create function public.refuse_version_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'versions are immutable: create a new version instead'
    using errcode = '55000';
end;
$$;

create trigger versions_refuse_update
before update on public.versions
for each row execute function public.refuse_version_update();

alter table public.versions enable row level security;

-- Defence in depth beside RLS: no anon access; authenticated may only read.
-- The reels grants are unchanged, so an owner cannot set current_version_id.
revoke all on public.versions from anon;
revoke all on public.versions from authenticated;
grant select on public.versions to authenticated;

create policy "versions: owner selects own"
on public.versions
for select
to authenticated
using ((select auth.uid()) = owner_id);

-- Saves one version in one transaction: locks the reel, refuses a parent that
-- is not the reel's current version (a stale or concurrent save), inserts the
-- row with the reel's owner and the next number, and makes it current.
-- Returns the number.
create function public.save_version(
  p_id uuid,
  p_reel_id uuid,
  p_parent_id uuid,
  p_restored_from_id uuid,
  p_request text,
  p_model text,
  p_prompt_version text,
  p_change_summary text,
  p_checks jsonb,
  p_inputs jsonb,
  p_r2_key text
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_current uuid;
  v_number int;
begin
  select r.owner_id, r.current_version_id
  into v_owner, v_current
  from public.reels r
  where r.id = p_reel_id
  for update;
  if not found then
    raise exception 'reel % does not exist', p_reel_id using errcode = 'P0002';
  end if;
  if p_parent_id is distinct from v_current then
    -- The default SQLSTATE (P0001): a serialization failure (40001) would be
    -- retried by the API instead of reported.
    raise exception 'parent % is not the current version % of reel %',
      p_parent_id, v_current, p_reel_id;
  end if;

  select coalesce(max(v.number), 0) + 1
  into v_number
  from public.versions v
  where v.reel_id = p_reel_id;

  insert into public.versions (
    id, reel_id, owner_id, number, parent_id, restored_from_id, request, model,
    prompt_version, change_summary, checks, inputs, r2_key
  ) values (
    p_id, p_reel_id, v_owner, v_number, p_parent_id, p_restored_from_id, p_request, p_model,
    p_prompt_version, p_change_summary, coalesce(p_checks, '[]'::jsonb), p_inputs, p_r2_key
  );

  update public.reels set current_version_id = p_id where id = p_reel_id;
  return v_number;
end;
$$;

-- Supabase's default privileges grant execute on new public functions to
-- every role: the worker's service role only.
revoke execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text
) to service_role;

-- Realtime delivers row changes, filtered by the same RLS policy.
alter publication supabase_realtime add table public.versions;
