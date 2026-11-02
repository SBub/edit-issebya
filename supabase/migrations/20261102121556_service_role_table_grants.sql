-- Explicit table grants for service_role, and local default privileges that
-- match the hosted project.
--
-- The hosted project's default privileges for objects postgres creates in
-- public give anon, authenticated and service_role only REFERENCES, TRIGGER,
-- TRUNCATE and MAINTAIN on tables, and nothing on sequences or functions. No
-- migration granted service_role any data privilege, so on hosted the worker
-- (secret key, role service_role) could not read or write a single table
-- (`permission denied for table jobs`). The local stack's defaults grant ALL,
-- which hid it from every test.
--
-- 1. service_role (the worker, the only code that holds the secret key) gets
--    select, insert, update, delete on every public table. It bypasses RLS, so
--    these grants are the whole of its access. The worker reads and writes
--    reels, jobs, steps, versions, exports and worker_status directly, and
--    stored_files through the security definer functions (record_stored_file,
--    slim_rebuildable_files, expire_export_files); it gets the same four on
--    stored_files too, so every table is uniform. That mirrors what Supabase
--    used to grant by default.
--
-- 2. Local default privileges are cut down to the hosted ones, so a future
--    table without explicit grants fails locally the way it would on hosted.
--    On hosted every revoke here is a no-op (it revokes what is not granted).
--
-- 3. Existing objects: the earlier migrations already left anon and
--    authenticated table and column grants equal on both stacks. The only
--    local leftovers are explicit EXECUTE grants on trigger functions that
--    hosted does not have: the four functions below keep PUBLIC's default
--    EXECUTE (as on hosted), and the two set-owner trigger functions keep
--    postgres only (hosted revoked PUBLIC and granted nobody). Trigger
--    functions are never called directly, and firing a trigger does not check
--    EXECUTE.
--
-- No grant to anon or authenticated is added.

-- 1. The worker's table access.
grant select, insert, update, delete on table
  public.reels,
  public.jobs,
  public.steps,
  public.versions,
  public.exports,
  public.stored_files,
  public.worker_status
to service_role;

-- 2. Default privileges as on hosted.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;

-- 3. Existing functions as on hosted.
revoke all on function public.set_updated_at() from anon, authenticated, service_role;
revoke all on function public.refuse_version_update() from anon, authenticated, service_role;
revoke all on function public.refuse_export_update() from anon, authenticated, service_role;
revoke all on function public.stored_files_refuse_update() from anon, authenticated, service_role;
revoke all on function public.exports_set_owner_and_expiry() from service_role;
revoke all on function public.stored_files_set_owner() from service_role;
