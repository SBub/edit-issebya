import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LANDING } from "@/content/landing";
import { siteUrl } from "@/lib/site-url";

import "./globals.css";

// metadataBase turns every relative metadata URL into an absolute one on the
// public address, read once at build time.
export const metadata: Metadata = {
  metadataBase: new URL(
    siteUrl({
      NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
      VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    }),
  ),
  title: "edit issebya",
  description: LANDING.description[0],
  // Link previews. The image comes from the opengraph-image and twitter-image
  // file conventions next to this layout, made absolute by metadataBase.
  openGraph: {
    type: "website",
    siteName: "edit issebya",
    title: "edit issebya",
    description: LANDING.description[0],
    locale: "en",
  },
  twitter: {
    card: "summary_large_image",
    title: "edit issebya",
    description: LANDING.description[0],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
