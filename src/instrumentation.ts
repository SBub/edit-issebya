import { isE2EMockStripe, setLastCheckout } from "@/lib/e2e-stripe-mock";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && isE2EMockStripe()) {
    await registerE2EStripeMock();
  }
}

/**
 * Starts an in-process MSW network so the Playwright suite can mock the one
 * server-side Stripe call (`POST https://api.stripe.com/v1/checkout/sessions`,
 * made by the startCheckout server action in src/app/actions.ts). Playwright's
 * browser-level `page.route()` cannot see it, since it happens inside this
 * Next.js server process. The handler stores the raw request body for the
 * /api/e2e-stripe-mock route and answers with a session whose url is the
 * success_url, so the browser lands back on `/?checkout=success`.
 *
 * Strictly opt-in: E2E_MOCK_STRIPE must be exactly "true", set only by
 * playwright.config.ts's webServer.env or by hand for the ADW server. Unset,
 * this is a no-op.
 */
async function registerE2EStripeMock(): Promise<void> {
  // webpackIgnore skips bundling these dynamic imports entirely (supported by
  // both webpack and Turbopack). Without it, Next's dev bundler also tries to
  // build msw into the Edge instrumentation graph (it builds every runtime
  // register() could run in, even though this branch only runs under
  // NEXT_RUNTIME === "nodejs"), and the Node-only @mswjs/interceptors subpath
  // exports do not resolve under the edge conditions, failing every route with
  // a 500. Left as a runtime import, Node resolves them normally.
  //
  // Only FetchInterceptor is installed, through msw 3's defineNetwork (the
  // successor of msw 2's SetupServerApi, and what setupServer() is built on),
  // instead of setupServer(), which installs all four interceptors. The Stripe
  // client under the flag goes through the global fetch (see src/lib/stripe.ts),
  // so nothing else is needed. It also keeps clear of a real bug class:
  // ClientRequestInterceptor proxies every outgoing http/https call in the
  // process through its passthrough socket even when nothing matches, and in
  // @mswjs/interceptors before 0.42 that socket could be torn down under
  // Node's dual-stack connect racing, raising an uncatchable `write ECANCELED`
  // and hanging the dev server's shutdown
  // (https://github.com/mswjs/interceptors/issues/753). 0.42 rewrote that
  // path; never installing the interceptor makes it moot either way.
  const { defineNetwork, InterceptorSource } = await import(
    /* webpackIgnore: true */ "msw/experimental"
  );
  const { http, HttpResponse } = await import(/* webpackIgnore: true */ "msw");
  const { FetchInterceptor } = await import(/* webpackIgnore: true */ "@mswjs/interceptors/fetch");

  const network = defineNetwork({
    sources: [new InterceptorSource({ interceptors: [new FetchInterceptor()] })],
    handlers: [
      http.post("https://api.stripe.com/v1/checkout/sessions", async ({ request }) => {
        const body = await request.text();
        setLastCheckout(body);
        const successUrl = new URLSearchParams(body).get("success_url") ?? "";
        const id = `cs_test_e2e_${crypto.randomUUID()}`;
        return HttpResponse.json({
          id,
          object: "checkout.session",
          url: successUrl.replace("{CHECKOUT_SESSION_ID}", id),
        });
      }),
    ],
    // Only the Stripe call above is mocked; everything else passes through.
    onUnhandledFrame: "bypass",
    context: { quiet: true },
  });
  await network.enable();
}
