-- Fixed pipeline steps, part two (app_docs/pipeline.md): after retime the reel moves through
-- removing_background (the speaker's cut-out), tracking_head (the head's position over time) and
-- making_previews (the small copies for the studio's live preview), then processed.
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
