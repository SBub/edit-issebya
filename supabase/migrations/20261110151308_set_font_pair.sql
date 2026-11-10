-- Saves the signed-in owner's font pair in one call. The studio used to upsert
-- the profiles row, which PostgREST turns into an insert ... on conflict that
-- also sets user_id: a change that authenticated has no UPDATE right on, so
-- every pick failed with "permission denied". This function does the same
-- upsert in the database, as the caller (security invoker): the insert and the
-- update go through the profiles policies, so a user writes only their own row
-- and only the pair. The caller is the auth user, never a parameter.

create function public.set_font_pair(p_font_pair text)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.profiles (user_id, font_pair)
  values ((select auth.uid()), p_font_pair)
  on conflict (user_id) do update set font_pair = excluded.font_pair;
$$;

revoke execute on function public.set_font_pair(text) from public, anon;
grant execute on function public.set_font_pair(text) to authenticated;
