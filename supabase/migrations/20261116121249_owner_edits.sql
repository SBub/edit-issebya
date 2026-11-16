-- The owner's moves (app_docs/owner-edits.md): in the studio the owner moves
-- and resizes a text component of a version and presses Save. That queues an
-- `owner_edit` job; the worker applies the moves to the version and saves the
-- result as a new version, marked as the owner's. For every component moved it
-- also keeps a learning record: where the layout engine placed it, where the
-- owner put it and what was on screen with it, so placement rules can be
-- learnt from the moves later.
--
-- 1. jobs: one more kind, `owner_edit`, carrying the version edited and the
--    moves in `owner_edit` (set for this kind only).
-- 2. versions: `edited_from_id`, the version the owner edited (null for every
--    other version); the versions list reads it to say "Edited by you".
-- 3. owner_moves: the learning records, one row per component moved.
-- 4. save_version: takes the two, and writes the version and its learning
--    records in one transaction.

-- 1. The job. The owner inserts it through the (reel_id, kind) grant, the
-- owner_edit grant and its own policy, which mirrors the relayout policy:
-- queued, its reel owned by the caller. The worker checks the payload itself
-- (the version is one of the reel's, each move a text component inside the
-- safe zone). Status, lease, attempt and error columns stay the worker's.
alter table public.jobs
  drop constraint jobs_kind_check,
  add constraint jobs_kind_check check (
    kind in (
      'process', 'change', 'restore', 'render', 'describe_photo', 'start_over', 'relayout',
      'owner_edit'
    )
  ),
  add column owner_edit jsonb
    -- A case, so each test runs only once the one before holds (a missing key
    -- gives null, which a plain check would let through).
    constraint jobs_owner_edit_shape_check check (
      owner_edit is null
      or case
        when jsonb_typeof(owner_edit) <> 'object' then false
        when coalesce(jsonb_typeof(owner_edit -> 'version_id'), '') <> 'string' then false
        when coalesce(jsonb_typeof(owner_edit -> 'moves'), '') <> 'array' then false
        when pg_column_size(owner_edit) > 65536 then false
        else jsonb_array_length(owner_edit -> 'moves') between 1 and 200
      end
    ),
  add constraint jobs_owner_edit_check check (
    (kind = 'owner_edit') = (owner_edit is not null)
  );

comment on column public.jobs.owner_edit is
  'An owner_edit job''s payload: { version_id, moves: [{ id, x, y, size, width? }] }; null for every other kind.';

grant insert (owner_edit) on public.jobs to authenticated;

create policy "jobs: owner inserts an owner edit job for own reel"
on public.jobs
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and status = 'queued'
  and kind = 'owner_edit'
  and owner_edit is not null
  and exists (
    select 1 from public.reels r
    where r.id = jobs.reel_id and r.owner_id = (select auth.uid())
  )
);

-- 2. The owner's version names the version it was edited from, of the same
-- reel (like parent_id and restored_from_id). The table grants are table-wide
-- (authenticated select, service_role all), so the column needs none.
alter table public.versions
  add column edited_from_id uuid,
  add constraint versions_edited_from_fkey
    foreign key (edited_from_id, reel_id) references public.versions (id, reel_id);

comment on column public.versions.edited_from_id is
  'The version whose components the owner moved or resized to make this one; null for every other version.';

-- 3. The learning records. One row per component the owner moved or resized
-- in one save. A row is self-contained (the boxes, the head, the others on
-- screen, the text), so it can be analysed without the reel.
--
-- The rows go with their reel: reel_id references the reel on delete cascade,
-- so delete_reel (which deletes the reel row) removes them with it. They are
-- only needed until placement is worked out. version_id, from_version_id and
-- engine_version_id stay plain ids: the versions go with the same reel, and a
-- foreign key on each would add nothing. The rows also go with the owner's
-- account.
create table public.owner_moves (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  reel_id uuid not null references public.reels (id) on delete cascade,
  -- The owner's version the move was saved in, and the version edited.
  version_id uuid not null,
  from_version_id uuid not null,
  -- The engine-placed version the engine box was read from (the version the
  -- owner's edits started from, through any earlier edits and goings back).
  engine_version_id uuid not null,
  -- The component: its item id in the edit, its kind, the variant entry the
  -- engine placed it with (when its record names one) and its text.
  item text not null,
  component text not null
    constraint owner_moves_component_check check (
      component in ('ACCENT', 'QUESTION', 'BIGWORD', 'LIST', 'HOOK')
    ),
  variant text,
  text text not null,
  -- Its time on screen, in seconds.
  start_seconds numeric not null,
  end_seconds numeric not null,
  -- Where the engine placed it and where the owner put it: each a box in frame
  -- pixels with the text size, { x, y, width, height, size }.
  engine_box jsonb not null check (jsonb_typeof(engine_box) = 'object'),
  owner_box jsonb not null check (jsonb_typeof(owner_box) = 'object'),
  moved boolean not null,
  -- A new size, or a box of another width or height (its lines set again).
  resized boolean not null,
  -- The wrap width the owner set with an edge handle, in frame pixels at the
  -- owner's size (the text set on the fewest balanced lines that fit it); null
  -- when the version's lines were kept.
  wrap_width numeric,
  -- The moment: the frame, the font pair, the head's box over the component's
  -- time (null with no head), the zone the engine took, and everything else on
  -- screen with it ({ item, component, text, start, end, box, moved_by_owner }).
  context jsonb not null check (jsonb_typeof(context) = 'object'),
  created_at timestamptz not null default now(),
  -- One record per component and save.
  unique (version_id, item)
);

create index owner_moves_owner_idx on public.owner_moves (owner_id, created_at);
create index owner_moves_reel_idx on public.owner_moves (reel_id);

alter table public.owner_moves enable row level security;

-- Hosted default privileges grant no data access, and the local stack matches
-- them: each role is granted explicitly. No anon access; the owner only reads
-- their own rows; the worker (service role) writes them through save_version
-- and may read them all.
revoke all on public.owner_moves from anon, authenticated;
grant select on public.owner_moves to authenticated;
grant select, insert, update, delete on public.owner_moves to service_role;

create policy "owner_moves: owner selects own"
on public.owner_moves
for select
to authenticated
using ((select auth.uid()) = owner_id);

-- 4. save_version takes the edited-from version and the learning records as
-- two more parameters with defaults, so every existing caller stays valid.
-- Every other parameter, its order and its default stay as they were in
-- 20261109131344_drop_reel_forbid_flags.sql.
drop function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb,
  text, jsonb, jsonb
);

-- Saves one version in one transaction: locks the reel, refuses a parent that
-- is not the reel's current version (a stale or concurrent save), inserts the
-- row with the reel's owner and the next number, writes the owner's learning
-- records (one row per entry of p_owner_moves, none for every version that is
-- not the owner's edit) and makes the version current. Returns the number.
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
    text, start_seconds, end_seconds, engine_box, owner_box, moved, resized, wrap_width, context
  )
  select
    v_owner, p_reel_id, p_id, p_edited_from_id,
    coalesce((m ->> 'engine_version_id')::uuid, p_edited_from_id),
    m ->> 'item', m ->> 'component', m ->> 'variant', m ->> 'text',
    (m ->> 'start')::numeric, (m ->> 'end')::numeric,
    m -> 'engine', m -> 'owner',
    (m ->> 'moved')::boolean, (m ->> 'resized')::boolean,
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
-- every role: the worker's service role only.
revoke execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb,
  text, jsonb, jsonb, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.save_version(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text, boolean, jsonb, jsonb, jsonb,
  text, jsonb, jsonb, uuid, jsonb
) to service_role;

notify pgrst, 'reload schema';
