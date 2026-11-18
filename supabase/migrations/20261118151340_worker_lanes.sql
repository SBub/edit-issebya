-- Worker lanes (app_docs/studio.md, "Worker"). The worker runs two lanes at the
-- same time: exports (`render` jobs) in one, every other kind in the other, so
-- an upload, a photo or an owner's edit never waits behind an export. Each
-- lane claims with a kind filter:
--
--   claim_job(p_worker, p_lease_seconds, p_only_kinds, p_except_kinds)
--
-- `p_only_kinds`: claim only these kinds (null: any kind). `p_except_kinds`:
-- never claim these kinds (null: none left out). Both null is the claim as it
-- was, so a caller that passes two arguments keeps working.
--
-- The filter only narrows which job a caller may take. The order rule is
-- unchanged and still looks at every kind: one job per reel or photo at a
-- time, in order. So a reel's export waits for that reel's older jobs, and a
-- reel's later jobs wait for its export, whatever lane they run in.
--
-- The two-argument function is dropped first: a second function with the same
-- name would make a two-argument call ambiguous.

drop function public.claim_job(text, int);

create function public.claim_job(
  p_worker text,
  p_lease_seconds int,
  p_only_kinds text[] default null,
  p_except_kinds text[] default null
)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker is null or length(trim(p_worker)) = 0 then
    raise exception 'p_worker must not be empty' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 1 and 3600 then
    raise exception 'p_lease_seconds must be between 1 and 3600' using errcode = '22023';
  end if;

  return query
  with next as (
    select c.id
    from public.jobs c
    where (
        c.status = 'queued'
        or (c.status = 'waiting_ai' and c.not_before <= now())
        or (c.status = 'running' and c.lease_expires_at < now())
      )
      and (c.not_before is null or c.not_before <= now())
      -- The caller's lane.
      and (p_only_kinds is null or c.kind = any (p_only_kinds))
      and (p_except_kinds is null or c.kind <> all (p_except_kinds))
      -- One job per reel or photo at a time, in order: no live job of the
      -- same target, and no older job of it still queued, running or waiting
      -- for the AI. Every kind counts here, whatever the caller's lane.
      and not exists (
        select 1 from public.jobs o
        where (o.reel_id = c.reel_id or o.photo_id = c.photo_id)
          and o.id <> c.id
          and (
            (o.status = 'running' and o.lease_expires_at >= now())
            or (
              o.status in ('queued', 'running', 'waiting_ai')
              and (o.created_at, o.id) < (c.created_at, c.id)
            )
          )
      )
    order by c.created_at, c.id
    limit 1
    for update of c skip locked
  )
  update public.jobs j
  set status = 'running',
      lease_holder = p_worker,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = j.attempts + 1,
      started_at = now(),
      waiting_reason = null,
      not_before = null
  from next
  where j.id = next.id
  returning j.*;
end;
$$;

revoke execute on function public.claim_job(text, int, text[], text[])
  from public, anon, authenticated;
grant execute on function public.claim_job(text, int, text[], text[]) to service_role;
