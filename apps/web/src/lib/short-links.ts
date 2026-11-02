// Turns the short-link registry (src/content/links.ts) into the redirects
// next.config.ts serves. Relative imports only: next.config.ts loads this
// file, and the "@/" alias is not resolved there.

import type { ShortLink } from "../content/links";

// The landing page with the link's three UTM parameters, encoded the way
// URLSearchParams encodes them.
export function shortLinkTarget(link: ShortLink): string {
  const query = new URLSearchParams({
    utm_source: link.source,
    utm_medium: link.medium,
    utm_campaign: link.campaign,
  });
  return `/?${query.toString()}`;
}

interface Redirect {
  source: string;
  destination: string;
  permanent: boolean;
}

// One redirect per slug. Temporary (307), not permanent (308): a permanent
// redirect is cached by browsers and by link-preview crawlers such as
// WhatsApp's, so a later change to a link's target (a renamed campaign, a
// different landing path) would never reach people who already opened it.
// Any query on the short link itself (say `?notrack`) is passed through to the
// destination by Next.
export function shortLinkRedirects(links: readonly ShortLink[]): Redirect[] {
  return links.map((link) => ({
    source: `/${link.slug}`,
    destination: shortLinkTarget(link),
    permanent: false,
  }));
}
