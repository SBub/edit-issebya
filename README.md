# edit-issebya

The one-page landing site for edit.issebya.com, a reel editing service for founders and experts.
Next.js 16 (App Router), TypeScript, Tailwind CSS 4.

The repository is a Turborepo monorepo on Yarn workspaces:

```
apps/web/        the landing site (Next.js), workspace @edit-issebya/web
packages/        shared libraries, added once two apps need one (none yet)
turbo.json       the task pipeline the root scripts run through
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

## Checks

```bash
yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test
yarn build
yarn workspace @edit-issebya/web playwright install chromium   # once
yarn test:e2e                       # Playwright specs in apps/web/e2e/
```

`yarn test:e2e` starts its own server with the Stripe and Resend mocks on. Against a server that is
already running, start that one as `E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true yarn dev`.

## Docs

- Working rules: [`AGENTS.md`](AGENTS.md)
- Feature docs: [`docs/conditional-docs.md`](docs/conditional-docs.md)
- ADW profile: [`.adw/project.md`](.adw/project.md)
