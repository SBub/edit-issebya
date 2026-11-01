-- Where a reel's preview copies are. Their storage keys are
-- `cache/preview_copies/<fingerprint>/...`, and that fingerprint is computed
-- only inside the worker, so the worker records it here after the
-- preview_copies step (run or reused) and the studio's live preview finds the
-- copies through it. `authenticated` already selects every reels column under
-- the owner-read policy and is never granted update on it: only the worker
-- (secret key) writes this column.
alter table public.reels
  add column preview_copies_fingerprint text
    check (preview_copies_fingerprint ~ '^[0-9a-f]{64}$');
