-- The owner's transcript corrections (app_docs/owner-edits.md, "Transcript
-- corrections"; owner decisions 2026-11-19): a text fix the owner types into
-- a caption says what was really spoken. It is kept for the reel, one row per
-- spoken word, so every later rebuild (a font pair change, a Start over, the
-- decide of a reel processed again) reads the transcript with it: the owner
-- wins over the transcript and over the curator's word fixes. No pipeline
-- step writes this table, so the transcribe and retime caches never touch it.
--
-- The rows go with their reel (reel_id cascades) and with the owner's
-- account. The learning record of each fix (the text before and after, per
-- save) stays in owner_texts.
create table public.owner_word_corrections (
  reel_id uuid not null references public.reels (id) on delete cascade,
  -- The spoken word's id in the reel's transcript (w0001).
  word_id text not null
    constraint owner_word_corrections_word_id_check check (word_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- What the owner's caption shows for the word. Empty: the word joined the
  -- caption of the word before it (the owner typed fewer words than spoken).
  text text not null
    constraint owner_word_corrections_text_check check (char_length(text) <= 200),
  -- The word as the transcript had it when it was corrected: a correction is
  -- applied only while the transcript still has that word with this text.
  original_text text not null
    constraint owner_word_corrections_original_check check (char_length(original_text) <= 200),
  -- When the word was first corrected, and last (the worker sets it).
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (reel_id, word_id)
);

comment on table public.owner_word_corrections is
  'One row per spoken word the owner corrected in a caption (the studio''s Edit mode): the reel''s transcript corrections, applied by every rebuild. Written by the worker''s owner_edit job.';

create index owner_word_corrections_owner_idx on public.owner_word_corrections (owner_id);

alter table public.owner_word_corrections enable row level security;

-- Hosted default privileges grant no data access, and the local stack matches
-- them: each role is granted explicitly. No anon access; the owner only reads
-- their own rows; the worker (service role) writes them and may read them all.
revoke all on public.owner_word_corrections from anon, authenticated;
grant select on public.owner_word_corrections to authenticated;
grant select, insert, update, delete on public.owner_word_corrections to service_role;

create policy "owner_word_corrections: owner selects own"
on public.owner_word_corrections
for select
to authenticated
using ((select auth.uid()) = owner_id);
