import Link from "next/link";
import type { ReactNode } from "react";
import { LANDING } from "@/content/landing";

/**
 * The shell of the terms and privacy pages: the brand linking home, the
 * title and the body. Both are stubs until the owner's texts are ready.
 */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-6 lg:p-10">
      <Link
        href="/"
        aria-label={`${LANDING.brand.name} ${LANDING.brand.suffix}, home`}
        className="text-xl font-semibold tracking-tight"
      >
        {LANDING.brand.name}
        <sub className="ml-0.5 align-sub text-[0.5em] font-normal tracking-normal">
          {LANDING.brand.suffix}
        </sub>
      </Link>
      <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-neutral-700">{children}</div>
    </main>
  );
}
