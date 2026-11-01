-- Fixed pipeline steps, part two (app_docs/pipeline.md): after retime the reel moves through
-- background removal, head tracking and preview copies, one status per step, then processed.
-- steps.status is unchanged.
alter table public.reels
  drop constraint reels_status_check,
  add constraint reels_status_check check (
    status in (
      'uploading',
      'uploaded',
      'received',
      'converting',
      'transcribing',
      'retiming',
      'removing_background',
      'tracking_head',
      'making_previews',
      'processed',
      'failed'
    )
  );
