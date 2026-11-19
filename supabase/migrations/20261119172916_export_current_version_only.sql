-- A kept export is kept only while its version is the reel's current version
-- (app_docs/export.md, "The replace rule"). Before, the newest export of a
-- reel was offered for 48 hours whatever version it held, so after an edit the
-- reel's page still offered "Download v2" beside a newer current version.
--
-- 1. `kept_exports`: the one definition of "a reel has a kept export". At most
--    one row per reel: the newest export of the reel's current version, while
--    its `expires_at` has not passed. The studio reads only this view (the
--    reels list, the reel's page, the download link), never `exports` itself,
--    to decide what to offer. A new current version (an edit, a font change,
--    Start over, going back) takes the row away in the same moment. Going back
--    saves a new version, so it never brings an older version's export back.
--    `security_invoker`: the caller's own grants and RLS on `exports` and
--    `reels` apply, so an owner sees only their own.
-- 2. `expire_export_files` also returns the file of an export whose version is
--    no longer the reel's current version, so the worker's slimming removes it
--    on its next pass. The `exports` rows themselves stay.

create view public.kept_exports
with (security_invoker = true)
as
select distinct on (e.reel_id)
  e.id,
  e.reel_id,
  e.owner_id,
  e.job_id,
  e.version_id,
  e.r2_key,
  e.bytes,
  e.created_at,
  e.expires_at
from public.exports e
join public.reels r on r.id = e.reel_id and r.current_version_id = e.version_id
where e.expires_at > now()
order by e.reel_id, e.created_at desc, e.id desc;

-- Hosted default privileges grant no data access: each role explicitly. The
-- view is read only; anon gets nothing.
revoke all on public.kept_exports from public, anon, authenticated, service_role;
grant select on public.kept_exports to authenticated, service_role;

-- Marks and returns the export files under the prefix that are no longer
-- kept: the export expired, its version is no longer the reel's current
-- version, or a newer export of the same reel replaced it.
create or replace function public.expire_export_files(p_now timestamptz, p_prefix text)
returns table (r2_key text, bytes bigint)
language sql
security definer
set search_path = ''
as $$
  with marked as (
    update public.stored_files f
    set deleted_at = greatest(p_now, f.created_at)
    from public.exports e
    where f.deleted_at is null
      and f.kind = 'export'
      and starts_with(f.r2_key, p_prefix)
      and e.r2_key = f.r2_key
      and (
        e.expires_at < p_now
        or not exists (
          select 1 from public.reels r
          where r.id = e.reel_id
            and r.current_version_id = e.version_id
        )
        or exists (
          select 1 from public.exports n
          where n.reel_id = e.reel_id
            and (n.created_at, n.id) > (e.created_at, e.id)
        )
      )
    returning f.r2_key, f.bytes
  )
  select m.r2_key, max(m.bytes)
  from marked m
  group by m.r2_key
  order by m.r2_key;
$$;

revoke execute on function public.expire_export_files(timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.expire_export_files(timestamptz, text) to service_role;
