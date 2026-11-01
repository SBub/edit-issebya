-- Where a reel's preview copies are: { footage: EditRef, cutout: EditRef },
-- each { step: "preview_copies", fingerprint, file }. Written only by the
-- worker (service role) right after the pipeline, before the first version.
-- The studio signs download URLs for these keys, so owners must never write
-- it: the reels grants are unchanged (no owner update, the owner insert grant
-- names id, source_name and source_key only). reels is already in the
-- Realtime publication.

alter table public.reels add column preview_copies jsonb;
alter table public.reels
  add constraint reels_preview_copies_object
  check (preview_copies is null or jsonb_typeof(preview_copies) = 'object');

comment on column public.reels.preview_copies is
  'Preview copies of the footage and the cut-out ({ footage, cutout } edit refs). Worker only; owners read it.';
