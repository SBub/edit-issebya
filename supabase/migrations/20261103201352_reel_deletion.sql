-- Deleting a reel. The owner deletes a reel through delete_reel; its versions,
-- jobs, steps, exports and stored-file rows go with it through the existing
-- `on delete cascade` foreign keys. Before the row goes, every storage key the
-- reel has (each `stored_files` row's key, deleted or not, and the source key
-- with its in-flight multipart upload) is copied into `storage_deletions`, a
-- queue with no foreign key to the reel, so the cascade cannot drop it. The
-- worker drains the queue between jobs: it deletes each object no other live
-- `stored_files` row holds (a shared pipeline output stays for the reels that
-- still need it), removes the queue row on success, and on failure keeps it
-- with a later `not_before`, so a failed delete is retried and never
-- forgotten. record_stored_file now queues the key instead of failing when the
-- reel no longer exists (a job uploading in the moment its reel is deleted), so
-- nothing is left behind in storage.

create table public.storage_deletions (
  id uuid primary key default gen_random_uuid(),
  r2_key text not null unique check (length(r2_key) between 1 and 512),
  upload_id text
    constraint storage_deletions_upload_id_check check (
      upload_id is null
      or (upload_id ~ '^[A-Za-z0-9._~-]+$' and length(upload_id) <= 1024)
    ),
  -- For tracing only: the reel is gone by the time the row is read.
  reel_id uuid,
  queued_at timestamptz not null default now(),
  not_before timestamptz not null default now(),
  attempts int not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 500)
);

create index storage_deletions_not_before_idx on public.storage_deletions (not_before);

-- Only the worker (service role) reads and writes it, and only through the
-- functions below; signed-in users never see it.
alter table public.storage_deletions enable row level security;
-- The one policy is the worker's (service_role bypasses RLS anyway); no other
-- role has one, so a signed-in user sees and writes no row.
create policy "storage_deletions: worker only"
on public.storage_deletions
for all
to service_role
using (true)
with check (true);
revoke all on table public.storage_deletions from anon, authenticated;
grant select, insert, update, delete on table public.storage_deletions to service_role;

-- The owner deletes one of their reels. The reel is locked first, so a
-- concurrent record_stored_file either commits first (its row is queued here)
-- or waits and then finds the reel gone (and queues its key itself).
create function public.delete_reel(p_reel_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_key text;
  v_source_upload_id text;
begin
  select r.source_key, r.source_upload_id
    into v_source_key, v_source_upload_id
    from public.reels r
    where r.id = p_reel_id
      and r.owner_id = (select auth.uid())
    for update;
  if not found then
    raise exception 'no reel of yours with this id' using errcode = 'P0002';
  end if;

  insert into public.storage_deletions (r2_key, reel_id)
  select distinct f.r2_key, p_reel_id
    from public.stored_files f
    where f.reel_id = p_reel_id
  on conflict (r2_key) do nothing;

  if v_source_key is not null then
    insert into public.storage_deletions (r2_key, upload_id, reel_id)
    values (v_source_key, v_source_upload_id, p_reel_id)
    on conflict (r2_key) do update
      set upload_id = coalesce(excluded.upload_id, public.storage_deletions.upload_id),
          not_before = least(excluded.not_before, public.storage_deletions.not_before);
  end if;

  delete from public.reels where id = p_reel_id;
end;
$$;

revoke execute on function public.delete_reel(uuid) from public, anon, service_role;
grant execute on function public.delete_reel(uuid) to authenticated;

-- Records that a reel needs an object, as before: a second call for the same
-- reel and key adds nothing while the first row is undeleted (a retried job),
-- and the answer is true. When the reel no longer exists the key is queued for
-- deletion instead and the answer is false: the worker then stops the job.
drop function public.record_stored_file(uuid, text, text, text, bigint);

create function public.record_stored_file(
  p_reel_id uuid,
  p_r2_key text,
  p_step text,
  p_kind text,
  p_bytes bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Waits for a delete_reel holding the reel, then sees it gone.
  perform 1 from public.reels r where r.id = p_reel_id for key share;
  if not found then
    insert into public.storage_deletions (r2_key, reel_id)
    values (p_r2_key, p_reel_id)
    on conflict (r2_key) do nothing;
    return false;
  end if;
  insert into public.stored_files (reel_id, step, r2_key, bytes, kind)
  values (p_reel_id, p_step, p_r2_key, p_bytes, p_kind)
  on conflict (reel_id, r2_key) where deleted_at is null do nothing;
  return true;
end;
$$;

revoke execute on function public.record_stored_file(uuid, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.record_stored_file(uuid, text, text, text, bigint)
  to service_role;

-- The queue rows the worker may delete now under its key prefix, oldest
-- first. A queued key another live `stored_files` row holds now (another
-- reel's shared output, or a photo's) is dropped from the queue first: its
-- object stays in storage for that row.
create function public.pending_storage_deletions(p_prefix text, p_limit int)
returns table (id uuid, r2_key text, upload_id text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = '22023';
  end if;
  delete from public.storage_deletions d
    where exists (
      select 1 from public.stored_files f
      where f.r2_key = d.r2_key and f.deleted_at is null
    );
  return query
    select d.id, d.r2_key, d.upload_id
      from public.storage_deletions d
      where starts_with(d.r2_key, p_prefix)
        and d.not_before <= now()
      order by d.queued_at, d.id
      limit p_limit;
end;
$$;

-- The object is deleted: its queue row goes.
create function public.finish_storage_deletion(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.storage_deletions where id = p_id;
$$;

-- The delete failed: the row stays, with its error, and is due again in ten
-- minutes.
create function public.fail_storage_deletion(p_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.storage_deletions
    set attempts = attempts + 1,
        last_error = left(p_error, 500),
        not_before = now() + interval '10 minutes'
    where id = p_id;
$$;

revoke execute on function public.pending_storage_deletions(text, int)
  from public, anon, authenticated;
grant execute on function public.pending_storage_deletions(text, int) to service_role;
revoke execute on function public.finish_storage_deletion(uuid)
  from public, anon, authenticated;
grant execute on function public.finish_storage_deletion(uuid) to service_role;
revoke execute on function public.fail_storage_deletion(uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_storage_deletion(uuid, text) to service_role;
