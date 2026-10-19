// The landing page copy, read by the page and the e2e specs alike.
export const LANDING = {
  brand: { name: "edit", suffix: "issebya" },
  // Each paragraph is a list of sentences, one per line, with no full stops.
  description: [
    [
      "If you record talking heads but they never get edited, or they don't look like your brand or get your ideas across, I can help",
    ],
    ["Editing eats hours that should go into your business", "Hand that part to me"],
    [
      "I'm a reel editor for founders and experts",
      "We start with your ICP and UVP, and I design a visual identity for your reels",
      "You record and hand over the A and B roll, and I edit every reel to match",
    ],
  ],
  offer: "8 reels, each under 1 min*",
  offerNote: "*The offer is valid for 30 days from the moment of purchase",
  variations:
    "These are variations. Your variant will match your project's ICP and UVP or already established brand identity",
  cta: "Book your discovery call",
  cancelled: "Payment was not completed. You can try again any time.",
  thankYou:
    "Thank you. Your payment is in. I will email you within two working days to set up the discovery call.",
  unavailable: "Payment is not available right now. Please try again later.",
} as const;
