# Legal pages

`/terms` and `/privacy` are complete plain-English texts for a sole trader in Portugal
(trabalhador independente, VAT exempt under article 53 CIVA) selling the reel editing service
online to businesses and consumers, paid upfront through Stripe. Both render through `LegalPage`
(`src/components/LegalPage.tsx`) with `h2` sections (`LegalSection`, each with an anchor `id`).

## One place for the facts

- `src/content/legal.ts` (`LEGAL`): trading name, owner (Sviatlana Buben), NIF (330791745),
  address (Lagarto 5, 2705-044 Almoçageme, Portugal), email (`edit@issebya.com`), last-updated
  date, the complaints book, the consumer portal, the CNPD and the alternative dispute
  resolution entity (CNIACC, chosen by the owner).
- A value in `[[DOUBLE_BRACKETS]]` would be a placeholder; while any is left
  (`legalPlaceholdersPending`), both pages show "Draft: placeholders pending." under the title.
  None is left, so the pages show only "Last updated".
- Every number in the terms comes from `OFFER` and `EARLY_BIRD` (`reelCount`, `maxSeconds`,
  `footageDays`, `deliveryHours`, the prices) and `reelSlotsFor` (the reel-length rule).
  `src/lib/offer.test.ts` checks that the landing copy says the same numbers.

## Terms

Sections: who we are (DL 7/2004 and DL 24/2014 identity; the service is sold to businesses and
professionals, including sole traders with an open activity, buying for their business), the
service, reel length (anchor `#reel-length`: no extra price, a longer reel counts as one of the
reels per started minute, `reelSlotsFor` in `src/lib/offer.ts`), price and payment (early-bird
and standard from `OFFER`, no VAT, paid upfront via Stripe, fatura-recibo), the footage window
(reels not sent within the window expire, no refund), revisions (one round per reel), your
content (rights warranty, licence to edit, portfolio use unless the client opts out by email),
cancellation and right of withdrawal (anchor `#withdrawal`), liability, events outside our
control, changes, personal data, complaints and disputes (Livro de Reclamações Eletrónico,
CNIACC, consumer portal) and applicable law.

Withdrawal: the service is positioned for business use, and business buyers have no statutory
right of withdrawal. The checkout checkbox stays "I agree to the terms and conditions and the
privacy policy" (owner's decision), so nothing in the form records a business statement or an
express request to start. A short section for a buyer who is a consumer keeps the 14-day right
(DL 24/2014 article 10), says work starts once the visual identity process begins (the
discovery call), refunds what was paid minus the value of the work already done (the
discovery call, the visual identity and delivered reels), says the right is lost once all the
work is delivered, and keeps the model withdrawal form (Annex B). The confirmation email says
"Work starts right away. See <site>/terms#withdrawal for cancellations".

Legal note for the owner: DL 24/2014 article 15 makes a consumer pay for work done during the
14 days, and article 17(1)(a) ends the right on full performance, only when the consumer
expressly asked for an early start on a durable medium. Without that request in the form, a
consumer who withdraws may be entitled to a full refund.

## Privacy policy

Sections: who is responsible, what we collect, purposes and legal bases (contract, legal
obligation, consent for the newsletter, legitimate interest for security, messages, the
portfolio and cookieless analytics, with the right to object), processors (Stripe, Resend,
PostHog EU, Google Calendar, Vercel; WhatsApp as Meta's own controller) and US transfers (Data
Privacy Framework or SCCs), retention, rights and the CNPD, cookies and analytics, contact and
applicable law (GDPR, Lei 58/2019, Lei 41/2004).

The cookies section says the site stores nothing on the device: PostHog runs with
`cookieless_mode: "always"` (see `app_docs/analytics.md`), so analytics is anonymous and
aggregate, on the basis of legitimate interest, and no consent banner is needed.

## Rules

- Never hard-code a provider fact or an offer number in the legal pages: read `LEGAL`, `OFFER`
  or `EARLY_BIRD`.
- Never remove the "Draft: placeholders pending." note while a placeholder is left.
- Never put a price on longer reels: they count as more reels (`reelSlotsFor`).
- Never remove the complaints book link from the landing footer or the terms.
- Never describe analytics as storing anything on the device while it runs cookieless, and never
  add device storage for analytics without a consent prompt.
- Never remove the consumer withdrawal section or the model form: a buyer can be a consumer
  despite the business checkbox.
