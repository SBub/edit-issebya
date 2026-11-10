-- The re-layout job (font pairs, app_docs/font-pairs.md): one more job kind,
-- `relayout`, places the reel's current version again in another font pair,
-- from the AI answers that version was made from, with no AI call. It carries
-- the target pair in `font_pair`, set for this kind only (the check below), so
-- every other kind keeps it null.
--
-- The owner inserts it through the (reel_id, kind) grant, the font_pair grant
-- and its own policy, which mirrors the start over policy: queued, its reel
-- owned by the caller. Status, lease, attempt and error columns stay the
-- worker's.

alter table public.jobs
  drop constraint jobs_kind_check,
  add constraint jobs_kind_check check (
    kind in (
      'process', 'change', 'restore', 'render', 'describe_photo', 'start_over', 'relayout'
    )
  ),
  add column font_pair text
    constraint jobs_font_pair_check check (
      font_pair in ('classic', 'script', 'signature', 'handwritten', 'retro', 'bold')
    ),
  add constraint jobs_relayout_font_pair_check check (
    (kind = 'relayout') = (font_pair is not null)
  );

grant insert (font_pair) on public.jobs to authenticated;

create policy "jobs: owner inserts a relayout job for own reel"
on public.jobs
for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and status = 'queued'
  and kind = 'relayout'
  and font_pair is not null
  and exists (
    select 1 from public.reels r
    where r.id = jobs.reel_id and r.owner_id = (select auth.uid())
  )
);
