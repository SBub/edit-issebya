# Legal pages

`/terms` and `/privacy` are complete plain-English texts for a sole trader in Portugal
(trabalhador independente, VAT exempt under article 53 CIVA) selling the reel editing service
online to businesses and consumers, paid upfront through Stripe. Both render through `LegalPage`
(`src/components/LegalPage.tsx`) with `h2` sections (`LegalSection`, each with an anchor `id`).

## One place for the facts

- `src/content/legal.ts` (`LEGAL`): trading name, owner name, NIF, address, email
  (`edit@issebya.com`), last-updated date, the complaints book, the consumer portal, the CNPD and
  the alternative dispute resolution entity (default CNIACC).
- Unknown facts are placeholders in `[[DOUBLE_BRACKETS]]`: `[[OWNER_NAME]]`, `[[NIF]]`,
  `[[ADDRESS]]` and `[[ADR_ENTITY]]` (shown next to the CNIACC default).
- One rule still carries a visible `[[CONFIRM]]` marker (`Confirm`): the missing analytics
  consent on the privacy page. Set `OWNER_REVIEW_PENDING` to `false` once it is resolved.
- While any placeholder is left (`legalPlaceholdersPending`), both pages show "Draft:
  placeholders pending." under the title, above "Last updated".
- Every number in the terms comes from `OFFER` and `EARLY_BIRD` (`reelCount`, `maxSeconds`,
  `footageDays`, `deliveryHours`, the prices) and `reelSlotsFor` (the reel-length rule). `src/lib/offer.test.ts` checks that the landing
  copy says the same numbers.

## Terms

Sections: who we are (DL 7/2004 and DL 24/2014 identity), the service, reel length (anchor
`#reel-length`: no extra price, a longer reel counts as one of the reels per started minute,
`reelSlotsFor` in `src/lib/offer.ts`), price and payment (early-bird and standard
from `OFFER`, no VAT, paid upfront via Stripe, fatura-recibo), the footage window (reels not sent
within the window expire, no refund), revisions (one round per reel), your content (rights
warranty, licence to edit, portfolio use unless the client opts out by email), the
consumer right of withdrawal (14 days; proportional payment if the service starts at the
consumer's request; lost once fully performed; how to withdraw by email; the model withdrawal
form from Annex B of DL 24/2014; no statutory right for businesses), liability, events outside
our control, changes, personal data, complaints and disputes (Livro de Reclamações Eletrónico,
ADR entity, consumer portal) and applicable law.

## Privacy policy

Sections: who is responsible, what we collect, purposes and legal bases (contract, legal
obligation, consent for the newsletter, legitimate interest for security, messages and the
portfolio, with the right to object), processors (Stripe, Resend,
PostHog EU, Google Calendar, Vercel; WhatsApp as Meta's own controller) and US transfers (Data
Privacy Framework or SCCs), retention, rights and the CNPD, cookies and analytics, contact and
applicable law (GDPR, Lei 58/2019, Lei 41/2004).

The cookies section describes PostHog as configured in `instrumentation-client.ts`: on the
production site only, the default `localStorage+cookie` persistence sets a first-party
`ph_<project key>_posthog` cookie and the same identifier in local storage. Under Lei 41/2004
article 5 that needs prior consent; no consent prompt exists yet, which the page states with a
`[[CONFIRM]]` marker.

## Known gaps for the owner

- The checkout does not yet record the consumer's express request to start within the 14 days
  on a durable medium (DL 24/2014 article 15), which the proportional-payment rule relies on.
- No analytics consent prompt (see above).

## Rules

- Never hard-code a provider fact or an offer number in the legal pages: read `LEGAL`, `OFFER`
  or `EARLY_BIRD`.
- Never remove the "Draft: placeholders pending." note while a placeholder or `[[CONFIRM]]`
  marker is left.
- Never put a price on longer reels: they count as more reels (`reelSlotsFor`).
- Never remove the complaints book link from the landing footer or the terms.
- Never describe analytics as consented to until a consent prompt exists.
