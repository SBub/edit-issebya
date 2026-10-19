import { OFFER } from "./offer";

// What counts as one sold spot: a Checkout Session of this offer that is
// complete and paid. Pure, so the rule is unit-tested without Stripe.
interface SessionLike {
  status: string | null;
  payment_status: string;
  metadata: Record<string, string> | null;
}

export function isSoldSession(session: SessionLike): boolean {
  return (
    session.status === "complete" &&
    session.payment_status === "paid" &&
    session.metadata?.offer === OFFER.id
  );
}

// Walks every session the iterable yields (the SDK's auto-pagination over
// `checkout.sessions.list`) and counts the sold ones.
export async function countSold(sessions: AsyncIterable<SessionLike>): Promise<number> {
  let sold = 0;
  for await (const session of sessions) {
    if (isSoldSession(session)) sold += 1;
  }
  return sold;
}
