import Link from "next/link";
import type { ReactNode } from "react";
import { BRAND_CLASS, BrandName, PAGE_PADDING } from "@/components/Brand";
import { LANDING } from "@/content/landing";

/**
 * The shell of the terms and privacy pages: the brand linking home, the
 * title and the body. It shares the landing page's padding and brand
 * placement, so the brand stays put between pages; the brand link is a
 * direct flex child, so its top is the padding edge like the landing `h1`.
 * Both pages are stubs until the owner's texts are ready.
 */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className={`flex min-h-dvh flex-col gap-6 ${PAGE_PADDING}`}>
      <Link
        href="/"
        aria-label={`${LANDING.brand.name} ${LANDING.brand.suffix}, home`}
        className={`self-start ${BRAND_CLASS}`}
      >
        <BrandName />
      </Link>
      <h1 className="max-w-2xl text-2xl font-medium tracking-tight">{title}</h1>
      <div className="flex max-w-2xl flex-col gap-3 text-sm leading-relaxed text-neutral-700">
        {children}
      </div>
    </main>
  );
}
