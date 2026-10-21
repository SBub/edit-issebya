import type { NextConfig } from "next";
import { SHORT_LINKS } from "./src/content/links";
import { shortLinkRedirects } from "./src/lib/short-links";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Short links (`/cjo` and the rest) to the landing page with UTM tags; see
  // src/content/links.ts and app_docs/analytics.md, "Short links".
  redirects() {
    return shortLinkRedirects(SHORT_LINKS);
  },
  // Pin the Turbopack root to this directory so a stray lockfile higher up
  // the filesystem is never mistaken for the project root.
  turbopack: {
    root: import.meta.dirname,
  },
  // Next 16 otherwise writes its own AGENTS.md and CLAUDE.md on every `next
  // dev`. This repo keeps those files by hand; see AGENTS.md.
  agentRules: false,
};

export default nextConfig;
