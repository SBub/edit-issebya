# Patch: Root README gains the studio tree entries, "Run the studio locally" and `yarn test:db`

## Metadata

adw_id: `c95d56bf`
review_change_request: `Issue #1: Spec step 15 and an acceptance criterion require the root README.md to gain apps/studio/ and supabase/ in its tree, a "Run the studio locally" subsection (owner runs supabase start once, fill apps/studio/.env.development and apps/worker/.env.development from supabase status, supabase migration up --local, STUDIO_PORT=3001 yarn turbo run dev --filter=./apps/web --filter=./apps/studio, open http://localhost:3000/studio), and yarn test:db in its checks. git diff origin/develop -- README.md is empty. Resolution: On this branch, edit the root README.md. Add apps/studio/ and supabase/ to the repository tree. Add a "Run the studio locally" subsection with exactly the steps listed in spec step 15 (run instructions only, no feature description). Add yarn test:db to the list of checks. Use no em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-27-adw-c95d56bf-sdlc_planner-studio-zone-login-reels-list.md`
**Issue:** Spec step 15 requires the root `README.md` to list `apps/studio/` and `supabase/` in its
tree, carry a "Run the studio locally" subsection and include `yarn test:db` in its checks. The
branch left `README.md` untouched, while the new `apps/studio/README.md` already sends readers to
the root README for how to run the studio.
**Solution:** Edit only the root `README.md`: two tree lines, one `###` subsection under "Run it"
with the five spec step 15 steps, and one `yarn test:db` line in the Checks block. Run instructions
only, no feature description, no em-dashes.

## Files to Modify

Use these files to implement the patch:

- `README.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Add the two workspaces to the repository tree

- In the fenced tree block, after the `apps/web/` line, add (aligned with the existing columns):
  - `apps/studio/     the reel studio at /studio (Next.js), workspace @edit-issebya/studio`
  - `supabase/        local Supabase config and migrations`
- Leave the `packages/` and `turbo.json` lines as they are.

### Step 2: Add the "Run the studio locally" subsection

- Under `## Run it`, after the paragraph about `apps/web/.env.example`, add
  `### Run the studio locally` with these steps, in this order:
  1. The owner starts the shared local Supabase stack once: `supabase start`.
  2. Fill `apps/studio/.env.development` and `apps/worker/.env.development` (copy each folder's
     `.env.example`) from the values `supabase status` prints.
  3. Apply the migrations: `supabase migration up --local`.
  4. Start both apps from the root:
     `STUDIO_PORT=3001 yarn turbo run dev --filter=./apps/web --filter=./apps/studio`.
  5. Open `http://localhost:3000/studio` (the studio is reached through the landing page).
- Put the commands in a `bash` fenced block like the one above it. No description of what the
  studio does.

### Step 3: Add `yarn test:db` to the checks

- In the `## Checks` block, after `yarn build`, add
  `yarn test:db                         # Supabase integration tests, needs the local stack`
  (comment aligned with the existing `yarn test:e2e` comment).

### Step 4: Format and check for em-dashes

- Run `yarn format` if `yarn format:check` flags `README.md`, then confirm no em-dash.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`: Prettier over the whole repository, including `README.md`.
- `grep -rnP "\x{2014}" apps/studio apps/web/src/lib/studio-rewrites* app_docs/studio.md supabase .adw README.md`: returns nothing.
- `git diff origin/develop -- README.md`: shows the tree lines, the "Run the studio locally"
  subsection and the `yarn test:db` line.
- `yarn lint && yarn typecheck && yarn knip`: the commit hook gates, unchanged by a docs edit.

## Patch Scope

**Lines of code to change:** about 20 lines in `README.md`
**Risk level:** low
**Testing required:** format check and em-dash grep; documentation only, no code or test changes.
