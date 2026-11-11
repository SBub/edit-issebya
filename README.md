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

One command from the repository root starts the landing page, the studio, the worker (in Docker,
everything it needs inside the image) and local monitoring:

```bash
yarn dev:studio                    # checks, then runs everything; Ctrl-C stops it all
yarn dev:studio --check            # the checks only, no servers (same as yarn dev:studio:status)
yarn dev:studio add-owner <email>  # once: creates the owner account in the local auth
```

The worker image carries the cut-out's MODNet model (see
[the worker container doc](app_docs/worker-container.md)). Only for the manual fallback below (the
worker run natively), download it once per machine (about 26 MB, checked against its pinned
SHA-256; see [the pipeline doc](app_docs/pipeline.md)):

```bash
yarn workspace @edit-issebya/worker models:install
```

`scripts/dev-studio.sh` checks that Docker is running, starts the local Supabase stack
(`edit-issebya`, `supabase/config.toml`) if it is down, applies pending migrations
(`supabase migration up --local`), checks that `apps/web/.env.development`,
`apps/studio/.env.development` and `apps/worker/.env.development` exist (fill each from its
folder's `.env.example` with the values `supabase status` prints, the R2 worker keys and the
worker's `OPENROUTER_API_KEY`), builds the worker image and runs the worker doctor inside it (it
checks the key is set and makes no AI call, so a startup costs nothing). It stops at the first failure with a one-line reason. Once the studio answers it
prints:

- Studio: `http://localhost:3000/studio` (reached through the landing page)
- Magic link emails: Mailpit `http://127.0.0.1:54434`
- Database: Supabase Studio `http://127.0.0.1:54433`

Sign-in never creates a user (`shouldCreateUser: false`), so the owner account must exist in the
local auth: `yarn dev:studio add-owner <email>` creates it as a confirmed user through the local
Auth admin API (it refuses any host but `127.0.0.1` and `localhost`). Then sign in with that email;
the link arrives in Mailpit.

To watch the worker's traces and logs in a local Grafana, see [the monitoring section](app_docs/measurement.md#local-monitoring); for what each step uses of the CPU, memory, disk and network, see [resource metrics](app_docs/measurement.md#resource-metrics).

ADW runs use their own local stack (`edit-issebya-adw`, ports 54450 to 54459, see
`app_docs/adw-supabase-stack.md`), which the command never touches.

Manual fallback, each step by hand:

```bash
supabase start                               # the shared local Supabase stack
supabase migration up --local                # apply the migrations
yarn workspace @edit-issebya/worker models:install   # once: the cut-out's MODNet model
yarn workspace @edit-issebya/worker doctor   # checks the configuration and connections
yarn workspace @edit-issebya/worker doctor --ai   # also two tiny real, paid OpenRouter calls
STUDIO_PORT=3001 yarn turbo run dev --filter=./apps/web --filter=./apps/studio
yarn workspace @edit-issebya/worker worker   # in a second terminal: keeps taking jobs until stopped
yarn workspace @edit-issebya/worker once     # or: takes one job, then exits
```

`yarn dev` does not start the worker.

## Checks

```bash
yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test
yarn build
yarn test:db                        # Supabase integration tests, needs the local stack
yarn workspace @edit-issebya/web playwright install chromium webkit   # once
yarn test:e2e                       # Playwright specs in apps/web/e2e/
yarn workspace @edit-issebya/worker test:tools   # real ffmpeg and HyperFrames, Mac only
PORT=3000 STUDIO_PORT=3001 yarn workspace @edit-issebya/studio test:tools   # preview matches export, Mac only, needs the dev servers
```

`yarn test:e2e` starts its own server with the Stripe and Resend mocks on. Against a server that is
already running, start that one as `E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true yarn dev`.

## Docs

- Working rules: [`AGENTS.md`](AGENTS.md)
- Feature docs: [`docs/conditional-docs.md`](docs/conditional-docs.md)
- ADW profile: [`.adw/project.md`](.adw/project.md)

## License

All rights reserved. See [`LICENSE`](LICENSE).
