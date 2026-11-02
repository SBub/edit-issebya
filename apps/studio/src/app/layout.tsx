import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Studio",
  // A private tool: never indexed.
  robots: { index: false, follow: false },
};

// A bare dark body: each page owns its container (the reel page and the
// reels grid fill the screen, the sign-in and not-found pages a narrow column).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-surface font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
