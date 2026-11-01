import { join } from "node:path";
import type { NextConfig } from "next";

const monorepoRoot = join(import.meta.dirname, "..", "..");

// Host of the public address (edit.issebya.com in production), for a proxy
// that does not forward the host. Through the landing page Next's rewrite
// proxy sends x-forwarded-host, so dev and ADW runs on any port need no entry
// (allowedOrigins cannot wildcard a port).
function siteHost(): string | undefined {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) return undefined;
  try {
    return new URL(siteUrl).host;
  } catch {
    return undefined;
  }
}

const host = siteHost();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The studio is a zone of edit.issebya.com: the landing page (apps/web)
  // forwards /studio and /studio-static to it. The asset prefix must equal
  // STUDIO_ASSET_PREFIX in apps/web/src/lib/studio-rewrites.ts. See
  // app_docs/studio.md, "Zone and forwarding".
  basePath: "/studio",
  assetPrefix: "/studio-static",
  // A workspace package shipped as TypeScript source (no build step); Next
  // transpiles it like the app's own code.
  transpilePackages: ["@edit-issebya/storage", "@edit-issebya/edit"],
  ...(host ? { experimental: { serverActions: { allowedOrigins: [host] } } } : {}),
  // Same reason as apps/web: dependencies are hoisted to the repository root's
  // node_modules, so pin the Turbopack root and the output file tracing root
  // to that root (two levels up). Next wants both set to the same directory.
  turbopack: {
    root: monorepoRoot,
  },
  outputFileTracingRoot: monorepoRoot,
  // Next 16 otherwise writes its own AGENTS.md and CLAUDE.md on every `next
  // dev`. This repo keeps those files by hand; see AGENTS.md.
  agentRules: false,
};

export default nextConfig;
