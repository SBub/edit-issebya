import { join } from "node:path";
import type { NextConfig } from "next";
import { SHORT_LINKS } from "./src/content/links";
import { shortLinkRedirects } from "./src/lib/short-links";
import { studioOrigin, studioRewrites } from "./src/lib/studio-rewrites";

const monorepoRoot = join(import.meta.dirname, "..", "..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Short links (`/cjo` and the rest) to the landing page with UTM tags; see
  // src/content/links.ts and app_docs/analytics.md, "Short links".
  redirects() {
    return shortLinkRedirects(SHORT_LINKS);
  },
  // /studio and the studio's static files go to the studio's own deployment
  // (STUDIO_URL, else the local studio on STUDIO_PORT); see app_docs/studio.md,
  // "Zone and forwarding".
  rewrites() {
    return studioRewrites(studioOrigin(process.env));
  },
  // This app lives in apps/web of a Yarn workspace whose dependencies are
  // hoisted to the repository root's node_modules. Pin the Turbopack root and
  // the output file tracing root to that repository root (two levels up), so
  // modules resolve and serverless traces include them, and a stray lockfile
  // higher up the filesystem is never mistaken for it. Next wants both set to
  // the same directory.
  turbopack: {
    root: monorepoRoot,
  },
  outputFileTracingRoot: monorepoRoot,
  // Next 16 otherwise writes its own AGENTS.md and CLAUDE.md on every `next
  // dev`. This repo keeps those files by hand; see AGENTS.md.
  agentRules: false,
};

export default nextConfig;
