-- One more font pair, `modern` (app_docs/font-pairs.md): Inter Light for the
-- simple role, Inter Tight Bold for the artistic one. The two checks that list
-- the pair ids take the new id; nothing else changes.

alter table public.profiles
  drop constraint profiles_font_pair_check,
  add constraint profiles_font_pair_check check (
    font_pair in ('classic', 'script', 'signature', 'handwritten', 'retro', 'bold', 'modern')
  );

alter table public.jobs
  drop constraint jobs_font_pair_check,
  add constraint jobs_font_pair_check check (
    font_pair in ('classic', 'script', 'signature', 'handwritten', 'retro', 'bold', 'modern')
  );
