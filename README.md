# edit-issebya

The one-page landing site for edit.issebya.com, a reel editing service for founders and experts.
Next.js 16 (App Router), TypeScript, Tailwind CSS 4.

The repository is a Turborepo monorepo on Yarn workspaces:

```
apps/web/         the landing site (Next.js), workspace @edit-issebya/web
apps/studio/      the reel studio at /studio (Next.js), workspace @edit-issebya/studio
apps/worker/      the job worker (Node, runs on the owner's machine), workspace @edit-issebya/worker
packages/storage/ the storage library the studio and the worker share, workspace @edit-issebya/storage
packages/edit/    the edit model (format, preset, HarfBuzz builder, versions) the studio and the worker share, workspace @edit-issebya/edit
supabase/         local Supabase config and migrations
turbo.json        the task pipeline the root scripts run through
```

## Run it

Node 24 and Yarn through corepack (`corepack enable`). Every command runs from the repository root.

```bash
yarn install        # all workspaces; also installs the lefthook git hooks
yarn dev            # http://localhost:3000 (set PORT to change it)
```

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in the values you need; nothing is
required to build or run the page. Next reads env files from the app's folder, `apps/web/`, not
from the repository root.

### Run the studio locally

```bash
supabase start                      # once, by the owner: the shared local Supabase stack
# fill apps/studio/.env.development and apps/worker/.env.development (copy each folder's
# .env.example) from the values `supabase status` prints
supabase migration up --local       # apply the migrations
STUDIO_PORT=3001 yarn turbo run dev --filter=./apps/web --filter=./apps/studio
```

Open `http://localhost:3000/studio`: the studio is reached through the landing page. ADW runs use
their own local stack (`edit-issebya-adw`, ports 54450 to 54459, see
`app_docs/adw-supabase-stack.md`), which you do not need to start or stop.

### Run the worker locally

Copy `apps/worker/.env.example` to `apps/worker/.env.development` and fill it (the local Supabase
values from `supabase status`, the R2 worker keys). Then, from the repository root:

```bash
yarn workspace @edit-issebya/worker doctor   # checks the configuration and connections
yarn workspace @edit-issebya/worker worker   # long-running: keeps taking jobs until stopped
yarn workspace @edit-issebya/worker once     # takes one job, then exits
```

`yarn dev` does not start the worker; run it in its own terminal.

## Checks

```bash
yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test
yarn build
yarn test:db                        # Supabase integration tests, needs the local stack
yarn workspace @edit-issebya/web playwright install chromium webkit   # once
yarn test:e2e                       # Playwright specs in apps/web/e2e/
```

`yarn test:e2e` starts its own server with the Stripe and Resend mocks on. Against a server that is
already running, start that one as `E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true yarn dev`.

## Docs

- Working rules: [`AGENTS.md`](AGENTS.md)
- Feature docs: [`docs/conditional-docs.md`](docs/conditional-docs.md)
- ADW profile: [`.adw/project.md`](.adw/project.md)
