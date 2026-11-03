# Patch: the worker's poll reads only a storage_deletions id

## Metadata

adw_id: `0c90e622`
review_change_request: `Issue #2: The diff breaks an invariant from a feature doc's Rules without changing the rule. app_docs/studio.md:276 says 'Never read more than id in the worker's periodic check' (and line 171 says the poll reads 'only job ids'). AGENTS.md treats every such rule as binding: a change that breaks one must change the rule in the same commit. apps/worker/src/main.ts now calls deletions.pending(config.keyPrefix, 1) inside the poll's setInterval. That runs pending_storage_deletions on every poll, which returns id, r2_key and upload_id, and also runs a DELETE over storage_deletions before it returns. The periodic check therefore reads more than id and writes on every tick. Spec step 7 asked for this poll hook but did not update the rule, and the branch leaves the rule untouched. The behaviour change is real: the poll now writes. Resolution: Fixable by a patch on this branch, either way: (a) keep the design and update app_docs/studio.md in the same change, rewording the rule and line 171 to allow the poll's one-row storage_deletions check and saying why; or (b) keep the rule and make the poll read only an id, for example a small service_role-only function or a select of id from storage_deletions with not_before <= now() and limit 1, leaving the held-key cleanup to the pass that runs in the drain's claim. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-136-adw-0c90e622-sdlc_planner-delete-reel-from-list.md`
**Issue:** The poll in `apps/worker/src/main.ts` (the `setInterval` at about line 93) calls
`deletions.pending(config.keyPrefix, 1)`, that is the `pending_storage_deletions` RPC. That function
first runs a `DELETE` over `storage_deletions` (it drops held keys), then returns `id`, `r2_key` and
`upload_id`. So every poll tick writes and reads more than `id`. That breaks the `app_docs/studio.md`
rule "Never read more than `id` in the worker's periodic check" (Rules, about line 317) and the
"reading only job ids" wording (about line 199).
**Solution:** Option (b). Keep the rule. Make the poll's deletion check a read-only, id-only
PostgREST select, `storage_deletions.select("id")`, filtered to due rows (`not_before <= now`) under
the worker's key prefix, `limit(1)`, in the same shape as `claimableJobIds` in
`apps/worker/src/queue.ts`. Held-key cleanup stays in `pending_storage_deletions`, which only the
deletion pass in the drain's claim calls. A held key can make one poll signal the drainer for
nothing: the drain's pass then drops that row and later polls stop seeing it. No migration change:
`service_role` already has `select` on `storage_deletions` and its RLS policy. Change the
`studio.md` wording at line 199 so it stays accurate (ids only, now from two tables). Leave the rule
as it is.

## Files to Modify

- `apps/worker/src/storage-deletions.ts`: add the exported `dueStorageDeletionIds(db, prefix)`.
- `apps/worker/src/storage-deletions.test.ts`: a unit test for it with a stub client.
- `apps/worker/src/main.ts`: the poll calls it instead of `deletions.pending(...)`, and the header
  comment says so.
- `app_docs/studio.md`: the poll description at about line 199 (not the Rules).
- `app_docs/storage.md`: the `main.ts` bullet at about line 139.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Add an id-only due check in `apps/worker/src/storage-deletions.ts`

- Below `supabaseStorageDeletions`, add the following with a short comment. The comment says this is
  the poll's check: it reads only `id`, never writes, and leaves held keys to
  `pending_storage_deletions` in the pass.
  ```ts
  export async function dueStorageDeletionIds(
    db: SupabaseClient,
    prefix: string,
  ): Promise<string[]> {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("storage_deletions")
      .select("id")
      .like("r2_key", `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      .lte("not_before", now)
      .limit(1);
    if (error) throw new Error(`storage deletions not checked: ${error.message}`);
    return (data ?? []).map((row: { id: string }) => row.id);
  }
  ```
- Escaping `\`, `%` and `_` makes the `like` pattern a literal prefix match, the same as
  `starts_with(d.r2_key, p_prefix)` in the SQL function.
- Leave the `StorageDeletionQueue` interface and `runStorageDeletions` as they are.

### Step 2: Unit-test it in `apps/worker/src/storage-deletions.test.ts`

- Add `describe("dueStorageDeletionIds")`. Its stub `db` has `from(table)` and returns a chain that
  records `table`, the `select` columns, each `like` and `lte` call and the `limit`. `limit`
  resolves `{ data: [{ id: "d1" }], error: null }`.
- Assert the result is `["d1"]`. Assert the table is `storage_deletions` and the columns are exactly
  `"id"`. Assert `like` is `("r2_key", "dev/%")` for `PREFIX`, and `lte` is on `not_before` with an
  ISO timestamp. Assert `limit` is 1. Assert no `rpc` is called (the stub has no `rpc`, or it throws).
- Add one case: the prefix `a_b%/` gives the pattern `a\_b\%/%`.
- Add one case: an `error` from `limit` throws `storage deletions not checked: ...`.
- Cast the stub as in `queue.test.ts` (`as unknown as SupabaseClient`).

### Step 3: Use it in the poll in `apps/worker/src/main.ts`

- Import `dueStorageDeletionIds` from `./storage-deletions.ts` next to the existing two imports.
- In the `setInterval`, replace `deletions.pending(config.keyPrefix, 1).then((rows) => ...)` with
  `dueStorageDeletionIds(db, config.keyPrefix).then((ids) => { if (ids.length > 0) drainer.signal(); })`.
  Keep the same `.catch` log line.
- Reword the comment above it: the poll reads only the id of one due row, and the drain's claim runs
  the pass (which also drops held keys).
- In the file's header comment, change "reading only ids" so it says the check reads only ids, of
  jobs and of a due deletion row. Keep `deletions` (the drain's pass still uses it).

### Step 4: Update the docs (wording only, the rule stays)

- `app_docs/studio.md`, about line 199: replace "reading only job ids" with "reading only ids (a
  claimable job's, and one due `storage_deletions` row's under its prefix)". In the sentence added
  by this branch ("the poll signals the drainer when a due `storage_deletions` row waits and no job
  does"), add that the poll reads only that row's `id` and never writes, and that held keys are
  dropped by the pass. Do not touch the Rules line "Never read more than `id` in the worker's
  periodic check."
- `app_docs/storage.md`, about line 139: after "the poll signals the drainer when a due row waits
  and no job does", add "(it selects only one due row's `id` under the prefix, `dueStorageDeletionIds`;
  it never calls `pending_storage_deletions`)".
- No em-dashes.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `yarn turbo run lint --filter=./apps/worker`
- `yarn turbo run typecheck --filter=./apps/worker`
- `yarn knip`
- `yarn turbo run test --filter=./apps/worker`
- `grep -n "pending(" apps/worker/src/main.ts`: no match. The poll no longer calls the RPC, and
  `pending` is called only from `runStorageDeletions`.

## Patch Scope

**Lines of code to change:** about 50 (15 code, 30 test, 6 doc).
**Risk level:** low
**Testing required:** worker unit tests (the new `dueStorageDeletionIds` cases plus the existing
deletion-pass tests), lint, typecheck and knip. No migration, so there is no DB or E2E change. The
existing `reel-deletion.test.ts` DB test already checks that `service_role` reads the table and
that `authenticated` cannot.
