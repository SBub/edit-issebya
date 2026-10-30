import { LANDING } from "@/content/landing";

// The padding of `/`, `/terms` and `/privacy`, every height and breakpoint
// step included: they share it so the brand never moves between them.
export const PAGE_PADDING = "p-6 short:p-4 tiny:p-3 lg:p-10 lg:short:p-6";

// The brand's typography, the same on every page.
export const BRAND_CLASS = "text-xl font-semibold tracking-tight short:text-lg";

/** "edit" with "issebya" set small and low on its right, like a chemical index. */
export function BrandName() {
  return (
    <>
      {LANDING.brand.name}
      <sub className="ml-0.5 align-sub text-[0.5em] font-normal tracking-normal">
        {LANDING.brand.suffix}
      </sub>
    </>
  );
}
