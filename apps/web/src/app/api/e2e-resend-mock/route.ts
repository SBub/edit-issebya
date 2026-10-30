import { NextResponse } from "next/server";
import {
  clearRecordedEmails,
  getRecordedEmails,
  isE2EMockResend,
  setConfigMissingToggle,
} from "@/lib/e2e-resend-mock";

/**
 * E2E-only window into the Resend mock registered in src/instrumentation.ts.
 * GET returns every recorded email request (JSON body and Idempotency-Key);
 * DELETE clears the list; POST `{ configMissing }` makes the Stripe webhook
 * treat BOOKING_URL as missing.
 *
 * Every method 404s unless E2E_MOCK_RESEND is exactly "true", so the route is
 * inert in `yarn dev` and production.
 */
export const dynamic = "force-dynamic";

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function GET() {
  if (!isE2EMockResend()) return notFound();
  return NextResponse.json({ emails: getRecordedEmails() });
}

export async function POST(request: Request) {
  if (!isE2EMockResend()) return notFound();
  const payload = (await request.json().catch(() => null)) as { configMissing?: unknown } | null;
  const configMissing = payload?.configMissing === true;
  setConfigMissingToggle(configMissing);
  return NextResponse.json({ configMissing });
}

export function DELETE() {
  if (!isE2EMockResend()) return notFound();
  clearRecordedEmails();
  return NextResponse.json({ emails: [] });
}
