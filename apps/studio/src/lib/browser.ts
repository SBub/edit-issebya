// The part of Navigator the check reads (userAgentData is Chromium-only).
export interface NavigatorLike {
  userAgent: string;
  userAgentData?: { brands?: readonly { brand: string }[] };
}

// Whether the browser is Chromium-based (Chrome, Edge, Brave...): the live
// preview is built and tested for it.
export function isChromium(nav: NavigatorLike): boolean {
  const brands = nav.userAgentData?.brands;
  if (brands) return brands.some(({ brand }) => brand === "Chromium");
  return /\b(Chrome|Chromium)\//.test(nav.userAgent);
}
