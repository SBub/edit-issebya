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
  title: "edit.issebya.com",
  description: LANDING.subline,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
