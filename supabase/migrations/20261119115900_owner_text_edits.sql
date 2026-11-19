-- Text edits in the owner's Edit mode (app_docs/owner-edits.md; owner
-- decisions 2026-11-19): the owner fixes the words of one text in place (an
-- accent, a question, a big word, a list's lead-in or key phrase, the hook, a
-- caption block's group). A fix changes only that element; its time and its
-- spoken words stay. It is saved with Save through the same `owner_edit` job
-- into a new version, and each fix leaves a learning record.
--
-- 1. jobs: the payload may carry text edits, `{ version_id, moves, adds?,
--    texts? }`: texts 0 to 200, at least one move, card or text in total.
-- 2. owner_texts: the learning table, a sibling of owner_moves: one row per
--    text edited in one save (the text before and after, the element, its
--    spoken words).
-- 3. save_version: one more parameter with a default, `p_owner_texts`, written
--    in the same transaction as the version and its owner_moves rows.
--
-- This migration adds to 20261116121249_owner_edits.sql and
-- 20261117122655_owner_photo_cards.sql and never edits them.

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
      when owner_edit ? 'texts' and jsonb_typeof(owner_edit -> 'texts') <> 'array' then false
      when pg_column_size(owner_edit) > 65536 then false
      when jsonb_array_length(owner_edit -> 'moves') > 200 then false
      when jsonb_array_length(coalesce(owner_edit -> 'adds', '[]'::jsonb)) > 20 then false
      when jsonb_array_length(coalesce(owner_edit -> 'texts', '[]'::jsonb)) > 200 then false
      else jsonb_array_length(owner_edit -> 'moves')
        + jsonb_array_length(coalesce(owner_edit -> 'adds', '[]'::jsonb))
        + jsonb_array_length(coalesce(owner_edit -> 'texts', '[]'::jsonb)) >= 1
    end
  );

comment on column public.jobs.owner_edit is
  'An owner_edit job''s payload: { version_id, moves: [{ id, x, y, size, width? } or { id, kind: "box", x, y, width, rotation?, photo_id? }], adds?: [{ id: "owner-visual-N", photo_id, word, x, y, width }], texts?: [{ id, part?, text }] }; null for every other kind.';

-- 2. The learning records of the owner's text edits: what a text said and
-- what the owner made it say, on which element, over which spoken words. Like
-- owner_moves the rows are only needed while the edit model is being worked
-- out, so they go with their reel (reel_id cascades) and with the owner's
-- account; the version ids are plain ids, as the versions go with the same
-- reel.
create table public.owner_texts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  reel_id uuid not null references public.reels (id) on delete cascade,
  -- The owner's version the edit was saved in, and the version edited.
  version_id uuid not null,
  from_version_id uuid not null,
  -- The element: its id in the edit (a caption block's is block_<first
  -- caption>), the part of it edited (a list's level, lead or key; a caption
  -- block's group, by its first caption's id; empty for a text with no parts),
  -- its kind and the variant entry the engine placed it with.
  item text not null,
  part text not null default '',
  component text not null
    constraint owner_texts_component_check check (
      component in ('ACCENT', 'QUESTION', 'BIGWORD', 'LIST', 'HOOK', 'CAPTION')
    ),
  variant text,
  -- The text of the version edited and the owner's text. Never empty, never
  -- the same.
  before_text text not null,
  after_text text not null
    constraint owner_texts_after_check check (
      char_length(after_text) between 1 and 300 and after_text <> before_text
    ),
  -- The spoken words the text is tied to, as the transcript has them, and
  -- their ids; empty for the hook, which nobody says.
  words text not null default '',
  word_ids jsonb not null default '[]'::jsonb
    constraint owner_texts_word_ids_check check (jsonb_typeof(word_ids) = 'array'),
  -- Its time on screen, in seconds: a text edit never changes it.
  start_seconds numeric not null,
  end_seconds numeric not null,
  -- The moment: the frame, the font pair, the text size, the element's box
  -- before and after the edit.
  context jsonb not null check (jsonb_typeof(context) = 'object'),
  created_at timestamptz not null default now(),
  -- One record per edited text and save.
  unique (version_id, item, part)
);

comment on table public.owner_texts is
  'One row per text the owner edited in the studio''s Edit mode, per save: the element, its text before and after, and the spoken words it stays tied to. Written by save_version with the version.';

create index owner_texts_owner_idx on public.owner_texts (owner_id, created_at);
create index owner_texts_reel_idx on public.owner_texts (reel_id);

alter table public.owner_texts enable row level security;

-- Hosted default privileges grant no data access, and the local stack matches
-- them: each role is granted explicitly. No anon access; the owner only reads
-- their own rows; the worker (service role) writes them through save_version
-- and may read them all.
revoke all on public.owner_texts from anon, authenticated;
grant select on public.owner_texts to authenticated;
grant select, insert, update, delete on public.owner_texts to service_role;

create policy "owner_texts: owner selects own"
on public.owner_texts
for select
to authenticated
using ((select auth.uid()) = owner_id);

-- 3. save_version takes the text records as one more parameter with a
-- default, so every existing caller stays valid. Every other parameter, its
-- order and its default, and the body, stay as they were in
-- 20261117122655_owner_photo_cards.sql. A new parameter is a new signature:
-- the old function is dropped first, so there is never an overload.
drop function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb,
  text, jsonb, jsonb, uuid, jsonb
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
  p_used_free_field boolean default false,
  p_unexpressed jsonb default '[]'::jsonb,
  p_free_field jsonb default '[]'::jsonb,
  p_rejected_reasons jsonb default '[]'::jsonb,
  p_change_title text default null,
  p_engine_record jsonb default '[]'::jsonb,
  p_checklist jsonb default '[]'::jsonb,
  p_edited_from_id uuid default null,
  p_owner_moves jsonb default '[]'::jsonb,
  p_owner_texts jsonb default '[]'::jsonb
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
  if jsonb_array_length(coalesce(p_owner_texts, '[]'::jsonb)) > 0 and p_edited_from_id is null then
    raise exception 'owner texts need the version they were made on';
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

  insert into public.owner_texts (
    owner_id, reel_id, version_id, from_version_id, item, part, component, variant,
    before_text, after_text, words, word_ids, start_seconds, end_seconds, context
  )
  select
    v_owner, p_reel_id, p_id, p_edited_from_id,
    t ->> 'item', coalesce(t ->> 'part', ''), t ->> 'component', t ->> 'variant',
    t ->> 'before', t ->> 'after', coalesce(t ->> 'words', ''),
    coalesce(t -> 'word_ids', '[]'::jsonb),
    (t ->> 'start')::numeric, (t ->> 'end')::numeric,
    t -> 'context'
  from jsonb_array_elements(coalesce(p_owner_texts, '[]'::jsonb)) as t;

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
  text, jsonb, jsonb, uuid, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb,
  text, jsonb, jsonb, uuid, jsonb, jsonb
) to service_role;

notify pgrst, 'reload schema';
