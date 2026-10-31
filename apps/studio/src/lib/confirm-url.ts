interface ConfirmUrlSources {
  siteUrl?: string | null;
  forwardedProto?: string | null;
  forwardedHost?: string | null;
  host?: string | null;
}

// The address a magic link points at: the studio's confirmation route on the
// public origin. NEXT_PUBLIC_SITE_URL wins when set; otherwise the forwarded
// host the landing page's rewrite proxy sends, so each run's port stays right.
export function confirmUrl({ siteUrl, forwardedProto, forwardedHost, host }: ConfirmUrlSources) {
  const site = siteUrl?.trim().replace(/\/+$/, "");
  const origin =
    site || `${firstValue(forwardedProto) ?? "http"}://${firstValue(forwardedHost) ?? host}`;
  return `${origin}/studio/auth/confirm`;
}

// x-forwarded-* may carry a comma-separated chain; the first entry is the client's.
function firstValue(header: string | null | undefined): string | undefined {
  const first = header?.split(",")[0]?.trim();
  return first || undefined;
}
