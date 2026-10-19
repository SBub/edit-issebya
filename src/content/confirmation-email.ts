// The buyer's confirmation email, the owner's copy, read by the email builder
// (src/lib/confirmation-email.ts), its unit test and the e2e spec alike. The
// wording, line breaks, list markers and the emoji are literal: change them
// only on the owner's word.
//
// The body is a list of blocks separated by one blank line in the plain-text
// part. `[Name]` is replaced with the buyer's name and `[Book your call]` with
// the booking link (spelled out in plain text, an <a> in HTML), and
// `[Withdrawal terms]` with the terms' withdrawal URL (spelled out in plain
// text, an <a> showing the URL in HTML).

export const NAME_TOKEN = "[Name]";
export const BOOKING_TOKEN = "[Book your call]";
export const BOOKING_LINK_TEXT = "Book your call";
export const TERMS_TOKEN = "[Withdrawal terms]";

export type EmailBlock =
  // Lines of one paragraph; an optional bold heading as its first line.
  | { kind: "paragraph"; heading?: string; lines: readonly string[] }
  // "- item" lines in plain text, <ul> in HTML.
  | { kind: "bullets"; items: readonly string[] }
  // "1. item" lines under a heading in plain text, <ol> in HTML.
  | { kind: "steps"; heading: string; items: readonly string[] };

export const CONFIRMATION_EMAIL = {
  subject: "You're in. Let's book your discovery call",
  blocks: [
    { kind: "paragraph", lines: [`Hi ${NAME_TOKEN},`] },
    {
      kind: "paragraph",
      lines: [
        "Thank you, your payment is confirmed. I'm looking forward to working on your reels.",
      ],
    },
    {
      kind: "paragraph",
      heading: "Next step: book your discovery call",
      lines: ["Pick a time that works for you:", `👉 ${BOOKING_TOKEN}`],
    },
    {
      kind: "paragraph",
      lines: [
        "On the call, we'll go through your brand, your audience and what makes you different. I use that to design the visual identity for your reels.",
      ],
    },
    {
      kind: "paragraph",
      heading: "How to prepare",
      lines: [
        "The more I know before the call, the sharper your visual identity will be. Please have these ready:",
      ],
    },
    {
      kind: "bullets",
      items: [
        "Your ICP: who you want to reach. Their role, industry, what keeps them up at night.",
        "Your UVP: what makes you different from others in your space, in a sentence or two.",
        "Brand assets: logo, colours and fonts, if you have them.",
        "References: 2 or 3 reels or accounts whose look you like (they don't have to be in your industry).",
        "Your channels: links to the profiles where the reels will go.",
      ],
    },
    {
      kind: "paragraph",
      lines: ["Rough notes are fine. We'll sharpen them together on the call."],
    },
    {
      kind: "steps",
      heading: "What happens after the call",
      items: [
        "I send you a proposed visual identity for your reels, along with a recording guide.",
        "Once your visual identity is ready, your 30 days start. Send me footage for all 8 reels within that time.",
        "For each reel, you send the A and B roll, and I deliver the edited reel within 24 hours.",
      ],
    },
    {
      // Points to the cancellation and withdrawal terms (a durable copy of
      // where they are).
      kind: "paragraph",
      lines: [`Work starts right away. See ${TERMS_TOKEN} for cancellations`],
    },
    { kind: "paragraph", lines: ["If anything comes up, just reply to this email."] },
    { kind: "paragraph", lines: ["Talk soon,", "Sveta"] },
  ] satisfies readonly EmailBlock[],
} as const;
