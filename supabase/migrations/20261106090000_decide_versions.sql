-- What the decide step records on a version beside its edit: whether any item
-- uses the free `custom` field (computed by the worker from the saved edit,
-- never from the AI's claim), the AI's list of `{ item, why }` for each use of
-- it, and the requests the edit format could not express. Existing rows get
-- the defaults: `add column ... default` fires no row trigger, and the
-- immutability trigger fires on update only.

alter table public.versions
  add column used_free_field boolean not null default false,
  add column free_field jsonb not null default '[]'::jsonb
    check (jsonb_typeof(free_field) = 'array'),
  add column unexpressed jsonb not null default '[]'::jsonb
    check (jsonb_typeof(unexpressed) = 'array');

-- save_version with three more parameters. The old signature is dropped so a
-- caller cannot write a version without them; the body and its error codes
-- are those of 20261104090100_save_version_error_code.sql.
drop function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text
);

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
  p_used_free_field boolean,
  p_free_field jsonb,
  p_unexpressed jsonb
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
    -- The default code (P0001): PostgREST retries a serialization failure
    -- (40001) itself, so the caller would wait instead of hearing the refusal.
    raise exception 'parent % is not the current version % of reel %',
      p_parent_id, v_current_id, p_reel_id;
  end if;

  if p_restored_from_id is not null and not exists (
    select 1 from public.versions where id = p_restored_from_id and reel_id = p_reel_id
  ) then
    raise exception 'no version % of reel %', p_restored_from_id, p_reel_id
      using errcode = 'P0002';
  end if;

  insert into public.versions (
    id, reel_id, owner_id, number, parent_id, restored_from_id, request, model,
    prompt_version, change_summary, checks, inputs, r2_key, used_free_field,
    free_field, unexpressed
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
    p_r2_key,
    p_used_free_field,
    p_free_field,
    p_unexpressed
  )
  returning * into v_row;

  update public.reels set current_version_id = v_row.id where id = p_reel_id;
  return v_row;
end;
$$;

-- Only the worker may call it.
revoke execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb
) to service_role;
