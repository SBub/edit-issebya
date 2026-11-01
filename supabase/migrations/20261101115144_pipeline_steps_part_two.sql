-- Background removal, head tracking and preview copies (app_docs/pipeline.md): three more fixed
-- steps after retime, each with its own reel status, then processed.
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
