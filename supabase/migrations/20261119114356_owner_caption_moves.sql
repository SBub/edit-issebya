-- Caption blocks in the owner's editor (app_docs/owner-edits.md; owner
-- decision 2026-11-19): the owner moves, resizes and re-wraps a sentence's
-- captions as one block, like any text. Its move goes through the same
-- `owner_edit` job (a text move whose id is the block's, `block_<first
-- caption>`) and its learning record into the same table, with the component
-- `CAPTION`.
--
-- This migration adds to 20261116121249_owner_edits.sql and never edits it.

alter table public.owner_moves
  drop constraint owner_moves_component_check,
  add constraint owner_moves_component_check check (
    component in ('ACCENT', 'QUESTION', 'BIGWORD', 'LIST', 'HOOK', 'VISUAL', 'CAPTION')
  );

comment on column public.owner_moves.component is
  'ACCENT, QUESTION, BIGWORD, LIST, HOOK, VISUAL or CAPTION (a caption block: a sentence''s captions moved as one box; its item is block_<first caption id>).';

-- The table's grants are table-wide and unchanged; restated per role.
revoke all on public.owner_moves from anon, authenticated;
grant select on public.owner_moves to authenticated;
grant select, insert, update, delete on public.owner_moves to service_role;

notify pgrst, 'reload schema';
