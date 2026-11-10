-- The owner's profile: the font pair their reels are set in (`src/font-pairs.ts`
-- in packages/edit). One row per user, written by the studio's pair picker; a
-- user with no row has the classic pair, which is what the worker reads for
-- them (the decide step and the first version).
--
-- The user reads and writes only their own row, and may change only the pair:
-- user_id is set at the insert and updated_at by the trigger. The worker (the
-- service role) reads every row and writes none here.

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  font_pair text not null default 'classic'
    constraint profiles_font_pair_check check (
      font_pair in ('classic', 'script', 'signature', 'handwritten', 'retro', 'bold')
    ),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

-- Defence in depth beside RLS: no anon access; authenticated reads its row and
-- may insert or change only the columns the policies check.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (user_id, font_pair) on public.profiles to authenticated;
grant update (font_pair) on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;

create policy "profiles: owner selects own"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "profiles: owner inserts own"
on public.profiles
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "profiles: owner updates own"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
