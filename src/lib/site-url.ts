// The public address of the site, the base every absolute URL in the page
// metadata is resolved against (metadataBase in the root layout). Pure: the
// caller passes the environment, so nothing here reads process.env.

const LOCAL_SITE_URL = "http://localhost:3000";

interface SiteUrlEnv {
  NEXT_PUBLIC_SITE_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
}

// Trims whitespace, then strips trailing commas and slashes. Returns null
// unless what is left parses as an http(s) URL.
function normalise(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const value = raw.trim().replace(/[,/\s]+$/, "");
  if (!/^https?:\/\/[^/]/i.test(value) || !URL.canParse(value)) return null;
  return value;
}

// NEXT_PUBLIC_SITE_URL when it is a valid http(s) URL; otherwise the Vercel
// production domain over https; otherwise the local server.
export function siteUrl(env: SiteUrlEnv): string {
  const configured = normalise(env.NEXT_PUBLIC_SITE_URL);
  if (configured) return configured;
  const host = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const vercel = host ? normalise(`https://${host}`) : null;
  return vercel ?? LOCAL_SITE_URL;
}
