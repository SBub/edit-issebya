# edit-issebya

The one-page landing site for edit.issebya.com, a reel editing service for founders and experts.
Next.js 16 (App Router), TypeScript, Tailwind CSS 4.

## Run it

Node 24 and Yarn through corepack (`corepack enable`).

```bash
yarn install        # also installs the lefthook git hooks
yarn dev            # http://localhost:3000 (set PORT to change it)
```

Copy `.env.example` to `.env.local` and fill in the values you need; nothing is required to build
or run the page.

## Checks

```bash
yarn lint && yarn typecheck && yarn knip && yarn test
yarn build
yarn playwright install chromium   # once
yarn test:e2e                       # Playwright specs in e2e/
```

`yarn test:e2e` starts its own server with the Stripe mock on. Against a server that is already
running, start that one as `E2E_MOCK_STRIPE=true yarn dev`.

## Docs

- Working rules: [`AGENTS.md`](AGENTS.md)
- Feature docs: [`docs/conditional-docs.md`](docs/conditional-docs.md)
- ADW profile: [`.adw/project.md`](.adw/project.md)
