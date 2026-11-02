// The /studio zone: the landing page forwards the studio's paths and its
// static files to the studio's own deployment (Next.js multi-zones). Relative
// imports only: next.config.ts loads this file. See app_docs/studio.md, "Zone
// and forwarding".

// Must equal the studio's assetPrefix (apps/studio/next.config.ts).
export const STUDIO_ASSET_PREFIX = "/studio-static";

// process.env, or a literal in the unit test.
type StudioEnv = Record<string, string | undefined>;

// STUDIO_URL (the studio's Vercel address) wins; otherwise the local studio
// on STUDIO_PORT, 3001 by default. Read at build time for `next build`.
export function studioOrigin(env: StudioEnv): string {
  const url = env.STUDIO_URL?.trim().replace(/\/+$/, "");
  if (url) return url;
  const port = env.STUDIO_PORT?.trim() || "3001";
  return `http://localhost:${port}`;
}

interface Rewrite {
  source: string;
  destination: string;
}

export function studioRewrites(origin: string): Rewrite[] {
  return [
    { source: "/studio", destination: `${origin}/studio` },
    { source: "/studio/:path+", destination: `${origin}/studio/:path+` },
    {
      source: `${STUDIO_ASSET_PREFIX}/:path+`,
      destination: `${origin}${STUDIO_ASSET_PREFIX}/:path+`,
    },
  ];
}
