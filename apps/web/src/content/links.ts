// Short links for posts in WhatsApp groups and elsewhere: `/<slug>` redirects
// to `/` with utm_source, utm_medium and utm_campaign set, so PostHog's
// $pageview and the Checkout Session metadata record where the visit came
// from (see app_docs/analytics.md, "Short links").
//
// To add a link, append an entry: a new `slug` (lowercase letters, digits and
// hyphens, not an existing route or public file), lowercase `source`, `medium`
// and `campaign` values in the same alphabet, the group's name as `label`, and
// `posted` null. Set `posted` to the ISO date (YYYY-MM-DD) once the link has
// gone out. Never rename, reuse or remove a slug once it is posted: old
// messages keep pointing at it. `yarn test` checks every rule above.

export interface ShortLink {
  readonly slug: string;
  readonly source: string;
  readonly medium: string;
  readonly campaign: string;
  readonly label: string;
  readonly posted: string | null;
}

export const SHORT_LINKS: readonly ShortLink[] = [
  {
    slug: "cjo",
    source: "whatsapp",
    medium: "group",
    campaign: "careers-jobs-opportunities",
    label: "Careers // Jobs // Opportunities",
    posted: null,
  },
  {
    slug: "bcc",
    source: "whatsapp",
    medium: "group",
    campaign: "business-co-creation",
    label: "Business & Co-Creation",
    posted: null,
  },
  {
    slug: "fo",
    source: "whatsapp",
    medium: "group",
    campaign: "facilitators-offerings",
    label: "Facilitators & Offerings",
    posted: null,
  },
  {
    slug: "ffl",
    source: "whatsapp",
    medium: "group",
    campaign: "female-founders-lisbon",
    label: "Female Founders Lisbon",
    posted: null,
  },
  {
    slug: "lse",
    source: "whatsapp",
    medium: "group",
    campaign: "lisbon-startups-entrepreneurs",
    label: "Lisbon Startups & Entrepreneurs",
    posted: null,
  },
];
