-- Reel studio skeleton: one row per reel, owned by one account. The owner reads
-- their own rows through RLS; nobody writes through the publishable key (later
-- slices write through the worker's secret key or dedicated functions).

create table public.reels (
  id uuid primary key default gen_random_uuid(),
  -- on delete cascade lets test cleanup delete a user together with their reels.
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  status text not null default 'uploading'
    check (status in ('uploading', 'uploaded', 'received', 'failed')),
  source_key text,
  source_bytes bigint check (source_bytes >= 0),
  source_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index reels_owner_created_idx on public.reels (owner_id, created_at desc);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger reels_set_updated_at
before update on public.reels
for each row execute function public.set_updated_at();

alter table public.reels enable row level security;

-- Defence in depth beside RLS: no anon access at all, and authenticated may
-- only read.
revoke all on public.reels from anon;
revoke insert, update, delete on public.reels from authenticated;
grant select on public.reels to authenticated;

create policy "reels: owner selects own"
on public.reels
for select
to authenticated
using ((select auth.uid()) = owner_id);

-- Realtime delivers row changes, filtered by the same RLS policy.
alter publication supabase_realtime add table public.reels;
