-- The change-request insert policy's name was longer than Postgres's 63-byte
-- identifier limit and was stored truncated; give it a name that fits.
alter policy "jobs: owner inserts a change or restore job for own processed r"
on public.jobs
rename to "jobs: owner queues a change or restore for own processed reel";
