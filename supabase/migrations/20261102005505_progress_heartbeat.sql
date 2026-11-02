-- Progress, time left and the worker heartbeat (slice 15). The two long steps
-- (`remove_background`, `render`) write their tool's progress into their own
-- step row, at most once every ten seconds, plus 100 at the end. A reel keeps
-- the length of its retimed footage, the divisor of the studio's time-left
-- estimate. The long-running worker writes a heartbeat into its
-- `worker_status` row every five minutes, so the studio can say since when it
-- is offline. RLS and the Realtime publication of all three tables already
-- cover the new columns: no grant or policy changes.

alter table public.steps
  add column progress_percent smallint check (progress_percent between 0 and 100),
  add column progress_updated_at timestamptz;

alter table public.reels
  add column footage_seconds numeric check (footage_seconds > 0);

alter table public.worker_status
  add column heartbeat_at timestamptz;
