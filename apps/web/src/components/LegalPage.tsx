import Link from "next/link";
import type { ReactNode } from "react";
import { BRAND_CLASS, BrandName, PAGE_PADDING } from "@/components/Brand";
import { LANDING } from "@/content/landing";
import { LEGAL, legalPlaceholdersPending } from "@/content/legal";

/**
 * The shell of the terms and privacy pages: the brand linking home, the
 * title, a "Draft: placeholders pending" note while any placeholder is left
 * (src/content/legal.ts), the last-updated date and the body. It shares the
 * landing page's padding and brand placement, so the brand stays put between
 * pages; the brand link is a direct flex child, so its top is the padding
 * edge like the landing `h1`.
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
      <div className="flex max-w-2xl flex-col gap-5 text-sm leading-relaxed text-neutral-700">
        <div className="flex flex-col gap-1 text-neutral-500">
          {legalPlaceholdersPending() ? <p>Draft: placeholders pending.</p> : null}
          <p>Last updated: {LEGAL.lastUpdated}</p>
        </div>
        {children}
      </div>
    </main>
  );
}

/** One section of a legal page: an `h2` and its body, with an anchor id. */
export function LegalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-6 flex-col gap-2">
      <h2 id={`${id}-title`} className="font-medium text-neutral-900">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** An external link that opens in a new tab. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/** The provider's email as a mailto link. */
export function EmailLink() {
  return (
    <a href={`mailto:${LEGAL.email}`} className="underline underline-offset-2">
      {LEGAL.email}
    </a>
  );
}
