-- save_version refused a stale parent with a serialization failure (40001),
-- which PostgREST retries on its own until the client gives up. Same function,
-- the default error code; its grants are unchanged (create or replace keeps
-- them).

create or replace function public.save_version(
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
