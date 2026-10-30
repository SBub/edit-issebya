import { isE2EMockResend, recordEmail } from "@/lib/e2e-resend-mock";
import { OFFER } from "@/lib/offer";
import {
  getSession,
  getSoldCountToggle,
  listedSessions,
  isE2EMockStripe,
  setLastCheckout,
  storeSession,
  updateSessionMetadata,
  formMetadata,
} from "@/lib/e2e-stripe-mock";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && (isE2EMockStripe() || isE2EMockResend())) {
    await registerE2EMocks({ stripe: isE2EMockStripe(), resend: isE2EMockResend() });
  }
}

/**
 * Starts an in-process MSW network so the Playwright suite can mock the
 * server-side Stripe calls (`POST https://api.stripe.com/v1/checkout/sessions`,
 * made by the startCheckout server action in src/app/actions.ts, and the
 * session retrieve and update the Stripe webhook makes) and the Resend email
 * call (`POST https://api.resend.com/emails`, made by the webhook). Playwright's
 * browser-level `page.route()` cannot see it, since it happens inside this
 * Next.js server process. The handler stores the raw request body for the
 * /api/e2e-stripe-mock route and answers with a session whose url is the
 * success_url, so the browser lands back on `/?checkout=success`.
 *
 * The create handler also stores the session it answered with, so the
 * retrieve and update handlers can read and merge into it. The Resend handler
 * records every request (JSON body and Idempotency-Key header) and does not
 * emulate idempotency, so a spec that sees no second email proves the
 * webhook's own flag check.
 *
 * Strictly opt-in: E2E_MOCK_STRIPE or E2E_MOCK_RESEND must be exactly "true",
 * set only by playwright.config.ts's webServer.env or by hand for the ADW
 * server, and each flag adds only its own handlers. Unset, this is a no-op.
 */
async function registerE2EMocks(flags: { stripe: boolean; resend: boolean }): Promise<void> {
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
  // and the Resend SDK always does, so nothing else is needed. It also keeps clear of a real bug class:
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

  const stripeHandlers = [
    http.post("https://api.stripe.com/v1/checkout/sessions", async ({ request }) => {
      const body = await request.text();
      setLastCheckout(body);
      const params = new URLSearchParams(body);
      const successUrl = params.get("success_url") ?? "";
      const id = `cs_test_e2e_${crypto.randomUUID()}`;
      return HttpResponse.json(
        storeSession(id, successUrl.replace("{CHECKOUT_SESSION_ID}", id), params),
      );
    }),
    // The sold count's list call, paginated like Stripe: `limit` per page,
    // `starting_after` the last id of the previous page.
    http.get("https://api.stripe.com/v1/checkout/sessions", ({ request }) => {
      const query = new URL(request.url).searchParams;
      const all = listedSessions(getSoldCountToggle(), OFFER.id);
      const limit = Number(query.get("limit") ?? 10) || 10;
      const after = query.get("starting_after");
      const start = after ? all.findIndex((session) => session.id === after) + 1 : 0;
      const data = all.slice(start, start + limit);
      return HttpResponse.json({
        object: "list",
        url: "/v1/checkout/sessions",
        has_more: start + limit < all.length,
        data,
      });
    }),
    http.get("https://api.stripe.com/v1/checkout/sessions/:id", ({ params }) => {
      const session = getSession(String(params.id));
      return session ? HttpResponse.json(session) : stripeNotFound(String(params.id));
    }),
    http.post("https://api.stripe.com/v1/checkout/sessions/:id", async ({ params, request }) => {
      const metadata = formMetadata(new URLSearchParams(await request.text()));
      const session = updateSessionMetadata(String(params.id), metadata);
      return session ? HttpResponse.json(session) : stripeNotFound(String(params.id));
    }),
  ];

  // Stripe's error shape for an unknown id.
  function stripeNotFound(id: string) {
    return HttpResponse.json(
      {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: `No such checkout.session: '${id}'`,
        },
      },
      { status: 404 },
    );
  }

  const resendHandlers = [
    http.post("https://api.resend.com/emails", async ({ request }) => {
      recordEmail({
        body: await request.json(),
        idempotencyKey: request.headers.get("Idempotency-Key"),
      });
      return HttpResponse.json({ id: crypto.randomUUID() });
    }),
  ];

  const network = defineNetwork({
    sources: [new InterceptorSource({ interceptors: [new FetchInterceptor()] })],
    handlers: [...(flags.stripe ? stripeHandlers : []), ...(flags.resend ? resendHandlers : [])],
    // Only the calls above are mocked; everything else passes through.
    onUnhandledFrame: "bypass",
    context: { quiet: true },
  });
  await network.enable();
}
