import type { Metadata } from "next";
import { Work_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { LANDING } from "@/content/landing";
import { siteUrl } from "@/lib/site-url";

import "./globals.css";

// The issebya.homes website's font, exposed as --font-sans through the theme.
const workSans = Work_Sans({ subsets: ["latin"], variable: "--font-work", display: "swap" });

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
    <html lang="en" className={workSans.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
