-- Failure kind and reel size (app_docs/status.md, app_docs/measurement.md).
-- A failed job says what kind of failure ended it (`transient`, `failed`, or
-- `answer_refused` when the AI's answer failed the checks twice) and, for a
-- refused answer, the names of the check rules it failed (rule names only,
-- never free text), so the reel page's overlay picks its actions from data.
-- The reel records its source's length and display size after
-- `check_footage`, and the transcript's word count after `retime`, written
-- once by the worker, so step timings can be read against the reel's size.
-- Owners read these columns through the existing table-level select grants
-- and never write them: the column-limited insert grants on jobs and reels
-- are unchanged and no update grant exists.

alter table public.jobs
  add column failure_kind text,
  add column failure_rules text[],
  add constraint jobs_failure_kind_check check (
    failure_kind is null or failure_kind in ('transient', 'failed', 'answer_refused')
  ),
  -- Only a failed job carries a failure kind; older failed rows keep null.
  add constraint jobs_failure_state_check check (failure_kind is null or status = 'failed'),
  -- Rule names belong to a refused answer only, between 1 and 20 of them.
  add constraint jobs_failure_rules_check check (
    failure_rules is null
    or (failure_kind = 'answer_refused' and cardinality(failure_rules) between 1 and 20)
  );

alter table public.reels
  add column source_seconds numeric check (source_seconds > 0),
  add column source_width integer check (source_width > 0),
  add column source_height integer check (source_height > 0),
  add column word_count integer check (word_count >= 0);
