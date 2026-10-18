import { NextResponse } from "next/server";
import {
  getLastCheckout,
  isE2EMockStripe,
  setKeyMissingToggle,
  setLastCheckout,
} from "@/lib/e2e-stripe-mock";

/**
 * E2E-only window into the Stripe mock registered in src/instrumentation.ts.
 * GET returns the last captured Checkout request body, parsed; POST
 * `{ keyMissing }` makes the server action behave as if no Stripe key were
 * set; DELETE clears the capture, so a spec that asserts "no request was made"
 * never sees an earlier spec's capture on the shared server.
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
  });
}

export async function POST(request: Request) {
  if (!isE2EMockStripe()) return notFound();
  const payload = (await request.json().catch(() => null)) as { keyMissing?: unknown } | null;
  const keyMissing = payload?.keyMissing === true;
  setKeyMissingToggle(keyMissing);
  return NextResponse.json({ keyMissing });
}

export function DELETE() {
  if (!isE2EMockStripe()) return notFound();
  setLastCheckout(null);
  return NextResponse.json({ body: null });
}
