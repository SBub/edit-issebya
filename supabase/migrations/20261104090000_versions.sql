-- Versions of a reel's edit: one immutable row per version, beside one
-- immutable object in R2 holding the complete edit
-- (`<prefix>reels/<reel id>/versions/<version id>.json`). The reel points at
-- its current version; restoring an old version makes a new one. Owners read
-- their own versions; only the worker (secret key) writes, through
-- save_version.

create table public.versions (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid not null references public.reels (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Shown as "version N": ordered without trusting created_at.
  number int not null check (number >= 1),
  parent_id uuid references public.versions (id),
  restored_from_id uuid references public.versions (id),
  request text,
  model text,
  prompt_version text,
  change_summary text,
  checks jsonb not null,
  inputs jsonb not null,
  r2_key text not null unique,
  created_at timestamptz not null default now(),
  unique (reel_id, number)
);

create index versions_reel_number_idx on public.versions (reel_id, number);

-- A saved version never changes. Deletes stay possible for the service role
-- and the reel's or the user's cascade only, since no role is granted delete.
create function public.versions_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'versions are immutable' using errcode = '42501';
end;
$$;

create trigger versions_immutable
before update on public.versions
for each row execute function public.versions_immutable();

alter table public.reels
  add column current_version_id uuid references public.versions (id) on delete set null;

alter table public.versions enable row level security;

revoke all on public.versions from anon;
revoke all on public.versions from authenticated;
grant select on public.versions to authenticated;

create policy "versions: owner selects own"
on public.versions
for select
to authenticated
using ((select auth.uid()) = owner_id);

-- The one way a version is written: locks the reel, refuses a parent that is
-- no longer its current version (two writers cannot fork history silently),
-- numbers the row, inserts it and makes it current, in one transaction. The
-- owner comes from the reel.
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
returns public.versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_current_id uuid;
  v_row public.versions;
begin
  select owner_id, current_version_id
  into v_owner_id, v_current_id
  from public.reels
  where id = p_reel_id
  for update;
  if not found then
    raise exception 'no reel %', p_reel_id using errcode = 'P0002';
  end if;

  if v_current_id is distinct from p_parent_id then
    raise exception 'parent % is not the current version % of reel %',
      p_parent_id, v_current_id, p_reel_id using errcode = '40001';
  end if;

  if p_restored_from_id is not null and not exists (
    select 1 from public.versions where id = p_restored_from_id and reel_id = p_reel_id
  ) then
    raise exception 'no version % of reel %', p_restored_from_id, p_reel_id
      using errcode = 'P0002';
  end if;

  insert into public.versions (
    id, reel_id, owner_id, number, parent_id, restored_from_id, request, model,
    prompt_version, change_summary, checks, inputs, r2_key
  )
  values (
    p_id,
    p_reel_id,
    v_owner_id,
    coalesce((select max(number) from public.versions where reel_id = p_reel_id), 0) + 1,
    p_parent_id,
    p_restored_from_id,
    p_request,
    p_model,
    p_prompt_version,
    p_change_summary,
    p_checks,
    p_inputs,
    p_r2_key
  )
  returning * into v_row;

  update public.reels set current_version_id = v_row.id where id = p_reel_id;
  return v_row;
end;
$$;

-- Supabase's default privileges grant execute on new public functions to
-- every API role: only the worker may call this one.
revoke execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text
) to service_role;
