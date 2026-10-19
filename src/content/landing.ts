// The landing page copy, read by the page and the e2e specs alike.
export const LANDING = {
  brand: { name: "edit", suffix: "issebya" },
  description: [
    "Your ideas deserve reels that look like your brand. And you deserve your evenings back.",
    "Editing eats hours that should go into your business. Hand that part to me.",
    "I'm a reel editor for founders and experts. I give your reels one consistent look, so people recognise you in the feed and remember your name.",
  ],
  howItWorks: {
    title: "How it works:",
    steps: [
      "Discovery call to understand your brand, ICP and UVP",
      "I propose a visual identity for your reels",
      "You hand over the A and B roll",
      "I deliver each edited reel within 24 hours",
    ],
  },
  whatYouGet: {
    title: "What you get:",
    items: [
      "Your visual identity (on our first project together)",
      "8 reels, each under 30 sec",
      "30 days to use all 8",
    ],
  },
  closing:
    "That works out to 2 reels a week. It's for founders who treat content as a distribution channel, not a side project.",
  variations:
    "These are variations. Your variant will match your project's ICP and UVP or already established brand identity",
  cta: "Book your discovery call",
  cancelled: "Payment was not completed. You can try again any time.",
  thankYou:
    "Thank you. Your payment is in. I will email you within two working days to set up the discovery call.",
  unavailable: "Payment is not available right now. Please try again later.",
} as const;
