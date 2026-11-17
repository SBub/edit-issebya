-- Pictures from the owner's photo library in the Move editor
-- (app_docs/owner-edits.md, app_docs/photo-library.md): the owner swaps a
-- VISUAL's picture for one of their library photos, or adds a new VISUAL
-- showing one at the paused moment. Both go through the same `owner_edit` job
-- and the same learning table.
--
-- 1. jobs: the payload may carry added cards, `{ version_id, moves, adds? }`:
--    moves 0 to 200 plus adds 0 to 20, at least one in total. A swap is a box
--    move with a `photo_id`. The worker checks every photo is the reel owner's,
--    ready and with a large copy, and fills in its size itself.
-- 2. owner_moves: `added` (a card the owner added: no engine box, so
--    `engine_box` becomes nullable), `swapped` (a card's picture swapped for a
--    library photo), `photo_id` (the photo the card shows; a plain id, no
--    foreign key, so a row outlives the photo's deletion) and `replaced` (what a
--    swap replaced: the stand-in's file or the previous photo's id).
-- 3. save_version: the same signature, writing the four columns.
--
-- This migration adds to 20261116121249_owner_edits.sql and never edits it.

-- 1. The job's payload. A case, so each test runs only once the one before
-- holds (a missing key gives null, which a plain check would let through).
alter table public.jobs
  drop constraint jobs_owner_edit_shape_check,
  add constraint jobs_owner_edit_shape_check check (
    owner_edit is null
    or case
      when jsonb_typeof(owner_edit) <> 'object' then false
      when coalesce(jsonb_typeof(owner_edit -> 'version_id'), '') <> 'string' then false
      when coalesce(jsonb_typeof(owner_edit -> 'moves'), '') <> 'array' then false
      when owner_edit ? 'adds' and jsonb_typeof(owner_edit -> 'adds') <> 'array' then false
      when pg_column_size(owner_edit) > 65536 then false
      when jsonb_array_length(owner_edit -> 'moves') > 200 then false
      when jsonb_array_length(coalesce(owner_edit -> 'adds', '[]'::jsonb)) > 20 then false
      else jsonb_array_length(owner_edit -> 'moves')
        + jsonb_array_length(coalesce(owner_edit -> 'adds', '[]'::jsonb)) >= 1
    end
  );

comment on column public.jobs.owner_edit is
  'An owner_edit job''s payload: { version_id, moves: [{ id, x, y, size, width? } or { id, kind: "box", x, y, width, rotation?, photo_id? }], adds?: [{ id: "owner-visual-N", photo_id, word, x, y, width }] }; null for every other kind.';

-- 2. The learning records of swapped and added cards. The table's grants are
-- table-wide (authenticated select under RLS, service_role all), so the new
-- columns need none; they are restated for clarity.
alter table public.owner_moves
  alter column engine_box drop not null,
  add column added boolean not null default false,
  add column swapped boolean not null default false,
  add column photo_id uuid,
  add column replaced text,
  -- An added card has no engine box; every other row has one.
  add constraint owner_moves_added_check check (added = (engine_box is null));

comment on column public.owner_moves.engine_box is
  'Where the engine placed the component, { x, y, width, height, size }; null for a card the owner added.';
comment on column public.owner_moves.photo_id is
  'The library photo the card shows (a plain id: the row outlives the photo); null for a text or a card without one.';
comment on column public.owner_moves.replaced is
  'What a swap replaced: the stand-in''s file or the previous photo''s id; null when nothing was swapped.';

revoke all on public.owner_moves from anon, authenticated;
grant select on public.owner_moves to authenticated;
grant select, insert, update, delete on public.owner_moves to service_role;

-- 3. save_version, the same signature as in 20261116121249_owner_edits.sql,
-- writing the four new columns (absent keys give false and null; a JSON null
-- engine box is stored as SQL null).
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
  p_r2_key text,
  p_used_free_field boolean default false,
  p_unexpressed jsonb default '[]'::jsonb,
  p_free_field jsonb default '[]'::jsonb,
  p_rejected_reasons jsonb default '[]'::jsonb,
  p_change_title text default null,
  p_engine_record jsonb default '[]'::jsonb,
  p_checklist jsonb default '[]'::jsonb,
  p_edited_from_id uuid default null,
  p_owner_moves jsonb default '[]'::jsonb
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
  if jsonb_array_length(coalesce(p_owner_moves, '[]'::jsonb)) > 0 and p_edited_from_id is null then
    raise exception 'owner moves need the version they were made on';
  end if;

  select coalesce(max(v.number), 0) + 1
  into v_number
  from public.versions v
  where v.reel_id = p_reel_id;

  insert into public.versions (
    id, reel_id, owner_id, number, parent_id, restored_from_id, request, model,
    prompt_version, change_title, change_summary, checks, inputs, r2_key,
    used_free_field, unexpressed, free_field, rejected_reasons, engine_record, checklist,
    edited_from_id
  ) values (
    p_id, p_reel_id, v_owner, v_number, p_parent_id, p_restored_from_id, p_request, p_model,
    p_prompt_version, p_change_title, p_change_summary, coalesce(p_checks, '[]'::jsonb), p_inputs, p_r2_key,
    coalesce(p_used_free_field, false), coalesce(p_unexpressed, '[]'::jsonb),
    coalesce(p_free_field, '[]'::jsonb), coalesce(p_rejected_reasons, '[]'::jsonb),
    coalesce(p_engine_record, '[]'::jsonb), coalesce(p_checklist, '[]'::jsonb),
    p_edited_from_id
  );

  insert into public.owner_moves (
    owner_id, reel_id, version_id, from_version_id, engine_version_id, item, component, variant,
    text, start_seconds, end_seconds, engine_box, owner_box, moved, resized, rotated,
    engine_rotation, owner_rotation, added, swapped, photo_id, replaced, wrap_width, context
  )
  select
    v_owner, p_reel_id, p_id, p_edited_from_id,
    coalesce((m ->> 'engine_version_id')::uuid, p_edited_from_id),
    m ->> 'item', m ->> 'component', m ->> 'variant', m ->> 'text',
    (m ->> 'start')::numeric, (m ->> 'end')::numeric,
    nullif(m -> 'engine', 'null'::jsonb), m -> 'owner',
    (m ->> 'moved')::boolean, (m ->> 'resized')::boolean,
    coalesce((m ->> 'rotated')::boolean, false),
    coalesce((m ->> 'engine_rotation')::integer, 0),
    coalesce((m ->> 'owner_rotation')::integer, 0),
    coalesce((m ->> 'added')::boolean, false),
    coalesce((m ->> 'swapped')::boolean, false),
    (m ->> 'photo_id')::uuid,
    m ->> 'replaced',
    (m ->> 'wrap_width')::numeric,
    m -> 'context'
  from jsonb_array_elements(coalesce(p_owner_moves, '[]'::jsonb)) as m;

  update public.reels
  set current_version_id = p_id
  where id = p_reel_id;
  return v_number;
end;
$$;

-- Supabase's default privileges grant execute on new public functions to
-- every role; `create or replace` keeps the grants, restated here: the
-- worker's service role only.
revoke execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb,
  text, jsonb, jsonb, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb,
  text, jsonb, jsonb, uuid, jsonb
) to service_role;

notify pgrst, 'reload schema';
