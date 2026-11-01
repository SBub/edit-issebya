-- Fixed pipeline steps (app_docs/pipeline.md): convert, transcribe and retime, each cached by the
-- fingerprint of its inputs, settings and code version. A step whose outputs are already stored is
-- recorded skipped with cache_hit true; the reel moves through one status per step, then processed.
-- received stays allowed for existing rows; nothing new writes it.
alter table public.steps
  add column cache_hit boolean not null default false,
  drop constraint steps_status_check,
  add constraint steps_status_check check (status in ('running', 'done', 'failed', 'skipped'));

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
      'processed',
      'failed'
    )
  );
