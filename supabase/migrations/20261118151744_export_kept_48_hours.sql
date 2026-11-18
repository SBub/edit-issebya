-- A finished export is kept for 48 hours (app_docs/export.md). Export no
-- longer blocks the studio: the owner may leave while it renders and download
-- the MP4 later, from the reels list or the reel's page. Three changes:
--
-- 1. One named setting, `export_keep_interval()`: how long an export's file
--    is kept after it was made. The insert trigger reads it, so the value is
--    written in this one place. To change it later, replace the function in a
--    new migration; rows already made keep the expiry they were given.
-- 2. The expiry check no longer repeats the value (it would be a second
--    place): an export only has to expire after it was made. Rows made under
--    the 1-hour and the 24-hour rules keep their expiry.
-- 3. One kept export per reel, the newest. `expire_export_files` also returns
--    the file of an export that a newer export of the same reel replaced, so
--    the worker's slimming removes it on its next pass instead of 48 hours
--    later. The `exports` rows themselves stay (the slimming of rebuildable
--    files reads the last export's date from them).

create function public.export_keep_interval()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '48 hours';
$$;

revoke execute on function public.export_keep_interval() from public, anon, authenticated;
grant execute on function public.export_keep_interval() to service_role;

alter table public.exports
  drop constraint exports_expiry_check,
  add constraint exports_expiry_check check (expires_at > created_at);

-- As in 20261103164248_one_step_export.sql, with the expiry from the setting.
create or replace function public.exports_set_owner_and_expiry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select j.status into v_status
  from public.jobs j
  where j.id = new.job_id
  for share;
  if v_status = 'cancelled' then
    raise exception 'export refused: the job was cancelled' using errcode = '55000';
  end if;
  new.expires_at := new.created_at + public.export_keep_interval();
  new.owner_id := (select r.owner_id from public.reels r where r.id = new.reel_id);
  return new;
end;
$$;

revoke execute on function public.exports_set_owner_and_expiry() from public, anon, authenticated;

-- Marks and returns the export files under the prefix that are no longer
-- kept: the export expired, or a newer export of the same reel replaced it.
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
