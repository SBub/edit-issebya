import { NextResponse } from "next/server";
import {
  clearSessions,
  getLastCheckout,
  isE2EMockStripe,
  listSessions,
  setKeyMissingToggle,
  setLastCheckout,
  setSessionPaymentStatus,
  setSoldCountToggle,
} from "@/lib/e2e-stripe-mock";

/**
 * E2E-only window into the Stripe mock registered in src/instrumentation.ts.
 * GET returns the last captured Checkout request body, parsed, and the stored
 * sessions; POST `{ keyMissing }` makes the server action (and the webhook)
 * behave as if no Stripe key were set, and POST `{ sessionId, paymentStatus }`
 * sets a stored session's payment_status, and POST `{ soldCount }` sets how
 * many paid sessions of the offer the mocked sessions list reports (the
 * early-bird state); DELETE clears the capture and the sessions and resets
 * the sold count to 0, so a spec that asserts "no request was made" never sees an
 * earlier spec's capture on the shared server.
 *
 * Every method 404s unless E2E_MOCK_STRIPE is exactly "true", so the route is
 * inert in `yarn dev` and production.
 */
export const dynamic = "force-dynamic";

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function GET() {
  if (!isE2EMockStripe()) return notFound();
  const body = getLastCheckout();
  return NextResponse.json({
    body: body === null ? null : Object.fromEntries(new URLSearchParams(body)),
    sessions: listSessions(),
  });
}

export async function POST(request: Request) {
  if (!isE2EMockStripe()) return notFound();
  const payload = (await request.json().catch(() => null)) as {
    keyMissing?: unknown;
    sessionId?: unknown;
    paymentStatus?: unknown;
    soldCount?: unknown;
  } | null;
  if (typeof payload?.soldCount === "number" && Number.isInteger(payload.soldCount)) {
    setSoldCountToggle(payload.soldCount);
    return NextResponse.json({ soldCount: payload.soldCount });
  }
  if (typeof payload?.sessionId === "string" && typeof payload.paymentStatus === "string") {
    const session = setSessionPaymentStatus(payload.sessionId, payload.paymentStatus);
    return session ? NextResponse.json({ session }) : notFound();
  }
  const keyMissing = payload?.keyMissing === true;
  setKeyMissingToggle(keyMissing);
  return NextResponse.json({ keyMissing });
}

export function DELETE() {
  if (!isE2EMockStripe()) return notFound();
  setLastCheckout(null);
  clearSessions();
  setSoldCountToggle(0);
  return NextResponse.json({ body: null, sessions: [] });
}
