# Conditional docs

One line per feature doc in `app_docs/`, saying when to read it; read the lines whose situation matches your task.

- Read `app_docs/landing-page.md` when changing the page layout, copy, height variants, the reel slider or reel cards, adding a reel, touching the no-scroll specs, or changing link previews (Open Graph, Twitter image, favicon).
- Read `app_docs/checkout.md` when changing the checkout form, the server action, the price, Stripe Checkout parameters or tax, the thank-you dialog, or the E2E Stripe mock, or the macOS 14 WebKit server (`.adw/worktree-env`).
- Read `app_docs/analytics.md` when changing PostHog start-up, the `?internal` tag, adding, renaming or removing an event, touching UTM handling, or adding or changing a short link (`apps/web/src/content/links.ts`, the redirects in `apps/web/next.config.ts`).
- Read `app_docs/confirmation-email.md` when changing the Stripe webhook, the confirmation email or owner notice copy, Resend, the email variables, or the E2E Resend mock.
- Read `app_docs/legal-pages.md` when changing the terms or privacy pages, the provider facts or placeholders in `apps/web/src/content/legal.ts`, the complaints book link, or anything the legal texts describe (price, reel length, footage window, data processors, analytics cookies).
- Read `app_docs/studio.md` when changing anything under `apps/studio`, the `/studio` forwarding (`apps/web/src/lib/studio-rewrites.ts`, `assetPrefix`), the magic-link login, the `reels`, `jobs` or `steps` tables, their RLS or migrations, the upload to R2, `claim_job` and the lease, `apps/worker`, `packages/storage`, the storage and AI test doubles, or the studio's DB and E2E tests.
