-- Version decide records: what the decide step adds to every version it
-- makes. `used_free_field` says whether any item needed the free `style`
-- field, `free_field` which items and why, `unexpressed` the requests the edit
-- format could not express, `rejected_reasons` why the first answer was
-- refused when a retry was needed. save_version takes them, with defaults
-- that keep every existing caller valid.

alter table public.versions
  add column used_free_field boolean not null default false,
  add column unexpressed jsonb not null default '[]'::jsonb
    check (jsonb_typeof(unexpressed) = 'array'),
  add column free_field jsonb not null default '[]'::jsonb
    check (jsonb_typeof(free_field) = 'array'),
  add column rejected_reasons jsonb not null default '[]'::jsonb
    check (jsonb_typeof(rejected_reasons) = 'array');

comment on column public.versions.used_free_field is
  'Some item of this version sets the free style field.';
comment on column public.versions.unexpressed is
  'The requests the edit format could not express (strings).';
comment on column public.versions.free_field is
  'The items that needed the style field and why ({ item, reason }).';
comment on column public.versions.rejected_reasons is
  'Why the first answer was refused when a retry was needed; empty when the first answer passed.';

drop function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text
);

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
  p_r2_key text,
  p_used_free_field boolean default false,
  p_unexpressed jsonb default '[]'::jsonb,
  p_free_field jsonb default '[]'::jsonb,
  p_rejected_reasons jsonb default '[]'::jsonb
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
    prompt_version, change_summary, checks, inputs, r2_key,
    used_free_field, unexpressed, free_field, rejected_reasons
  ) values (
    p_id, p_reel_id, v_owner, v_number, p_parent_id, p_restored_from_id, p_request, p_model,
    p_prompt_version, p_change_summary, coalesce(p_checks, '[]'::jsonb), p_inputs, p_r2_key,
    coalesce(p_used_free_field, false), coalesce(p_unexpressed, '[]'::jsonb),
    coalesce(p_free_field, '[]'::jsonb), coalesce(p_rejected_reasons, '[]'::jsonb)
  );

  update public.reels set current_version_id = p_id where id = p_reel_id;
  return v_number;
end;
$$;

-- Supabase's default privileges grant execute on new public functions to
-- every role: the worker's service role only.
revoke execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb
) to service_role;

notify pgrst, 'reload schema';
