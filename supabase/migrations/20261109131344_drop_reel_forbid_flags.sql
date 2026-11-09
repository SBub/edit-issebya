-- The reel's behind forbids (`no_photos`, `no_big_word`) went with the change
-- box that set them: nothing sets them any more and no version reads them.
-- The columns go, and save_version loses its two parameters and the update of
-- the two flags. Every other parameter, its order and its default stay as they
-- were in 20261104013645_version_checklist.sql, so the worker's call (by name)
-- is the same minus the two. Its grants are re-applied as they were: the
-- service role only.

drop function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb,
  boolean, boolean, text, jsonb, jsonb
);

alter table public.reels
  drop column no_photos,
  drop column no_big_word;

-- Saves one version in one transaction: locks the reel, refuses a parent that
-- is not the reel's current version (a stale or concurrent save), inserts the
-- row with the reel's owner and the next number, and makes it current. Returns
-- the number.
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
  p_rejected_reasons jsonb default '[]'::jsonb,
  p_change_title text default null,
  p_engine_record jsonb default '[]'::jsonb,
  p_checklist jsonb default '[]'::jsonb
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
    prompt_version, change_title, change_summary, checks, inputs, r2_key,
    used_free_field, unexpressed, free_field, rejected_reasons, engine_record, checklist
  ) values (
    p_id, p_reel_id, v_owner, v_number, p_parent_id, p_restored_from_id, p_request, p_model,
    p_prompt_version, p_change_title, p_change_summary, coalesce(p_checks, '[]'::jsonb), p_inputs, p_r2_key,
    coalesce(p_used_free_field, false), coalesce(p_unexpressed, '[]'::jsonb),
    coalesce(p_free_field, '[]'::jsonb), coalesce(p_rejected_reasons, '[]'::jsonb),
    coalesce(p_engine_record, '[]'::jsonb), coalesce(p_checklist, '[]'::jsonb)
  );

  update public.reels
  set current_version_id = p_id
  where id = p_reel_id;
  return v_number;
end;
$$;

-- Supabase's default privileges grant execute on new public functions to
-- every role: the worker's service role only.
revoke execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb,
  text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb,
  text, jsonb, jsonb
) to service_role;

notify pgrst, 'reload schema';
