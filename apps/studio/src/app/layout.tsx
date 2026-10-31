import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Studio",
  // A private tool: never indexed.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
